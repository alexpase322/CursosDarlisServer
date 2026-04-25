// Servicio reutilizable para sincronizar pagos y suscripciones de Stripe
// con MongoDB. Lo usan tanto el script CLI (scripts/backfillStripePayments.js)
// como el botón de admin (POST /admin/stripe/sync-payments).
//
// Maneja:
//  1) Invoices pagadas → registros Payment idempotentes por stripeInvoiceId.
//  2) Suscripciones en trial (sin invoice de cobro real): crea un Payment
//     "marcador" con stripeInvoiceId = `trial_<subId>`, amountUSD = 0,
//     status='paid' para que la validación del invite acepte trials.
//  3) Refunds detectados al consultar el charge asociado al invoice.
//  4) Sincroniza User.subscription para usuarios existentes.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Payment = require('../models/Payment');
const User = require('../models/User');
const { inferPlan } = require('../config/affiliateConfig');

const ACTIVE_SUB_STATUSES = ['active', 'trialing', 'past_due'];

// Piso temporal: nunca consideramos pagos anteriores a esta fecha
// (anti-importación de cobros viejos no relacionados con la academia actual).
const PAID_AT_FLOOR = new Date('2026-03-01T00:00:00.000Z');
const PAID_AT_FLOOR_UNIX = Math.floor(PAID_AT_FLOOR.getTime() / 1000);

// Lee el subscriptionId de un invoice de Stripe, cubriendo API antigua y nueva.
const getSubscriptionIdFromInvoice = (invoice) => {
    if (!invoice) return null;
    if (invoice.subscription) return invoice.subscription;
    if (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription) {
        return invoice.parent.subscription_details.subscription;
    }
    const lines = invoice.lines && invoice.lines.data ? invoice.lines.data : [];
    for (const li of lines) {
        if (li.subscription) return li.subscription;
        if (li.parent && li.parent.subscription_item_details && li.parent.subscription_item_details.subscription) {
            return li.parent.subscription_item_details.subscription;
        }
    }
    return null;
};

async function syncStripePayments(opts = {}) {
    const {
        dryRun = false,
        planFilter = null,
        since = null,           // unix seconds
        onlyRegistered = true,  // filtra por emails ya en BD (no admin)
        log = () => {}
    } = opts;

    if (!process.env.STRIPE_SECRET_KEY) {
        throw new Error('Falta STRIPE_SECRET_KEY');
    }

    const counters = {
        scanned: 0,
        inserted: 0,
        alreadyExisted: 0,
        skipped: 0,
        skippedTooOld: 0,
        skippedNotRegistered: 0,
        refunded: 0,
        usersUpdated: 0,
        trialsRecorded: 0,
        syntheticTrialsCleaned: 0,
        oldPaymentsCleaned: 0
    };

    // Cleanup: borra cualquier Payment ya guardado con paidAt anterior al piso.
    if (!dryRun) {
        const delOld = await Payment.deleteMany({ paidAt: { $lt: PAID_AT_FLOOR } });
        counters.oldPaymentsCleaned = delOld.deletedCount || 0;
        if (counters.oldPaymentsCleaned > 0) {
            log(`cleanup: ${counters.oldPaymentsCleaned} pagos previos a ${PAID_AT_FLOOR.toISOString().slice(0,10)} eliminados`);
        }
    }

    // Cleanup previo: si ya existe un Payment "real" para una sub, eliminamos
    // cualquier marcador sintético `trial_<subId>` que haya quedado de runs viejos.
    if (!dryRun) {
        const realSubIds = await Payment.distinct('stripeSubscriptionId', {
            stripeInvoiceId: { $not: /^trial_/ },
            stripeSubscriptionId: { $ne: null }
        });
        if (realSubIds.length > 0) {
            const syntheticIds = realSubIds.map(s => `trial_${s}`);
            const del = await Payment.deleteMany({ stripeInvoiceId: { $in: syntheticIds } });
            counters.syntheticTrialsCleaned = del.deletedCount || 0;
            if (counters.syntheticTrialsCleaned > 0) {
                log(`cleanup: ${counters.syntheticTrialsCleaned} marcadores trial sintéticos eliminados`);
            }
        }
    }

    // Whitelist de emails permitidos (usuarios no admin existentes en BD).
    let allowedEmails = null;
    if (onlyRegistered) {
        const dbUsers = await User.find({ role: { $ne: 'admin' } }).select('email').lean();
        allowedEmails = new Set(
            dbUsers.map(u => (u.email || '').toLowerCase().trim()).filter(Boolean)
        );
        log(`whitelist: ${allowedEmails.size} emails (rol != admin)`);
        if (allowedEmails.size === 0) {
            return counters;
        }
    }

    const customerEmailCache = new Map();
    async function getEmailFromCustomer(customerId) {
        if (!customerId) return null;
        if (customerEmailCache.has(customerId)) return customerEmailCache.get(customerId);
        try {
            const c = await stripe.customers.retrieve(customerId);
            const email = c && !c.deleted && c.email ? c.email.toLowerCase().trim() : null;
            customerEmailCache.set(customerId, email);
            return email;
        } catch {
            customerEmailCache.set(customerId, null);
            return null;
        }
    }

    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    async function syncUserSubscription(email, subscription, plan) {
        // Case-insensitive: el email en BD puede tener mayúsculas (no normalizado).
        const user = await User.findOne({ email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' } });
        if (!user) return;
        const wasInactive = !user.subscription || user.subscription.status !== 'active';
        user.subscription = {
            id: subscription.id,
            customerId: subscription.customer,
            status: subscription.status,
            plan: plan || (user.subscription && user.subscription.plan) || null,
            currentPeriodEnd: subscription.current_period_end
                ? new Date(subscription.current_period_end * 1000)
                : (user.subscription && user.subscription.currentPeriodEnd) || null
        };
        if (!dryRun) await user.save();
        if (wasInactive && ['active', 'trialing'].includes(subscription.status)) {
            counters.usersUpdated += 1;
        }
    }

    // ---------- Pase 1: invoices pagadas ----------
    // Piso temporal: el mayor entre el piso global y el `since` recibido.
    const effectiveSince = Math.max(PAID_AT_FLOOR_UNIX, since || 0);
    const listParams = { status: 'paid', limit: 100, created: { gte: effectiveSince } };

    for await (const invoice of stripe.invoices.list(listParams)) {
        counters.scanned += 1;

        const lineItem = invoice.lines && invoice.lines.data && invoice.lines.data[0];
        const priceId = lineItem && lineItem.price && lineItem.price.id;
        const amountUSD = invoice.amount_paid != null ? invoice.amount_paid / 100 : 0;
        const plan = inferPlan({ priceId, lineItem, amountUSD });
        if (planFilter && plan !== planFilter) {
            counters.skipped += 1;
            continue;
        }

        let email = (invoice.customer_email || '').toLowerCase().trim();
        if (!email) email = await getEmailFromCustomer(invoice.customer);
        if (!email) {
            counters.skipped += 1;
            continue;
        }
        if (allowedEmails && !allowedEmails.has(email)) {
            counters.skippedNotRegistered += 1;
            continue;
        }

        let refundedFlag = false;
        if (invoice.charge) {
            try {
                const charge = await stripe.charges.retrieve(invoice.charge);
                if (charge && charge.refunded) refundedFlag = true;
            } catch { /* noop */ }
        }

        const paidAt = invoice.status_transitions && invoice.status_transitions.paid_at
            ? new Date(invoice.status_transitions.paid_at * 1000)
            : new Date(invoice.created * 1000);

        if (paidAt < PAID_AT_FLOOR) {
            counters.skippedTooOld += 1;
            continue;
        }

        const subscriptionId = getSubscriptionIdFromInvoice(invoice);

        const doc = {
            email,
            stripeCustomerId: invoice.customer || null,
            stripeInvoiceId: invoice.id,
            stripeSubscriptionId: subscriptionId,
            plan: plan || 'monthly',
            amountUSD,
            status: refundedFlag ? 'refunded' : 'paid',
            paidAt,
            refundedAt: refundedFlag ? new Date() : null
        };

        if (dryRun) {
            counters.inserted += 1;
            if (refundedFlag) counters.refunded += 1;
            continue;
        }

        const existing = await Payment.findOne({ stripeInvoiceId: invoice.id }).lean();
        const result = await Payment.updateOne(
            { stripeInvoiceId: invoice.id },
            { $setOnInsert: doc },
            { upsert: true }
        );

        if (existing) {
            counters.alreadyExisted += 1;
            if (refundedFlag && existing.status !== 'refunded') {
                await Payment.updateOne(
                    { stripeInvoiceId: invoice.id },
                    { $set: { status: 'refunded', refundedAt: new Date() } }
                );
                counters.refunded += 1;
            }
        } else if (result.upsertedCount === 1) {
            counters.inserted += 1;
            if (refundedFlag) counters.refunded += 1;
            // Si entra un invoice real para una sub para la que ya creamos un marcador
            // sintético `trial_<subId>`, lo borramos para no duplicar.
            if (subscriptionId) {
                await Payment.deleteOne({ stripeInvoiceId: `trial_${subscriptionId}` });
            }
        }

        // Backfill: si el Payment ya existía pero sin stripeSubscriptionId,
        // lo actualizamos ahora que sabemos cómo extraerlo.
        if (existing && subscriptionId && !existing.stripeSubscriptionId) {
            await Payment.updateOne(
                { stripeInvoiceId: invoice.id },
                { $set: { stripeSubscriptionId: subscriptionId } }
            );
        }

        // Backfill: si el Payment ya existía con un plan inferido distinto
        // (por ej. todos los viejos quedaron como 'monthly'), lo corregimos.
        if (existing && plan && existing.plan !== plan) {
            await Payment.updateOne(
                { stripeInvoiceId: invoice.id },
                { $set: { plan } }
            );
        }

        if (subscriptionId) {
            try {
                const sub = await stripe.subscriptions.retrieve(subscriptionId);
                await syncUserSubscription(email, sub, plan);
            } catch (err) {
                log(`no pude leer sub ${subscriptionId}: ${err.message}`);
            }
        }
    }

    // ---------- Pase 2: suscripciones (incluye trials sin cobro real) ----------
    // Buscamos suscripciones activas/trialing/past_due de los emails permitidos
    // y aseguramos al menos un Payment "marcador" para que el invite valide.
    if (allowedEmails) {
        for (const email of allowedEmails) {
            // Buscar customer por email (puede haber varios customers en Stripe con mismo email)
            let customers = [];
            try {
                const list = await stripe.customers.list({ email, limit: 10 });
                customers = list.data || [];
            } catch (err) {
                log(`error listando customers ${email}: ${err.message}`);
                continue;
            }

            for (const customer of customers) {
                let subs = [];
                try {
                    const subList = await stripe.subscriptions.list({
                        customer: customer.id,
                        status: 'all',
                        limit: 100
                    });
                    subs = subList.data || [];
                } catch (err) {
                    log(`error listando subs ${customer.id}: ${err.message}`);
                    continue;
                }

                for (const sub of subs) {
                    if (!ACTIVE_SUB_STATUSES.includes(sub.status)) continue;
                    const subStartDate = sub.start_date ? new Date(sub.start_date * 1000) : null;
                    if (subStartDate && subStartDate < PAID_AT_FLOOR) continue;

                    const subItem = sub.items && sub.items.data && sub.items.data[0];
                    const subPriceId = subItem && subItem.price && subItem.price.id;
                    const subAmountUSD = subItem && subItem.price && subItem.price.unit_amount != null
                        ? subItem.price.unit_amount / 100
                        : null;
                    const plan = inferPlan({ priceId: subPriceId, lineItem: subItem, amountUSD: subAmountUSD });
                    if (planFilter && plan !== planFilter) continue;

                    // Sincronizar User.subscription siempre
                    await syncUserSubscription(email, sub, plan);

                    // ¿Ya tiene algún Payment 'paid' por esa suscripción?
                    const hasPayment = await Payment.exists({
                        stripeSubscriptionId: sub.id,
                        status: 'paid'
                    });
                    if (hasPayment) continue;

                    // Crear marcador (trial / cortesía / cualquier acceso sin invoice cobrada)
                    const trialDoc = {
                        email,
                        stripeCustomerId: customer.id,
                        stripeInvoiceId: `trial_${sub.id}`,
                        stripeSubscriptionId: sub.id,
                        plan: plan || 'monthly',
                        amountUSD: 0,
                        status: 'paid',
                        paidAt: sub.start_date ? new Date(sub.start_date * 1000) : new Date()
                    };

                    if (dryRun) {
                        counters.trialsRecorded += 1;
                        continue;
                    }

                    const result = await Payment.updateOne(
                        { stripeInvoiceId: trialDoc.stripeInvoiceId },
                        { $setOnInsert: trialDoc },
                        { upsert: true }
                    );
                    if (result.upsertedCount === 1) {
                        counters.trialsRecorded += 1;
                        counters.inserted += 1;
                    } else {
                        counters.alreadyExisted += 1;
                    }
                }
            }
        }
    }

    return counters;
}

module.exports = { syncStripePayments };
