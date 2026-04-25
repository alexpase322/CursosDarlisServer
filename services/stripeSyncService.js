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
const { planFromStripePriceId } = require('../config/affiliateConfig');

const ACTIVE_SUB_STATUSES = ['active', 'trialing', 'past_due'];

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
        skippedNotRegistered: 0,
        refunded: 0,
        usersUpdated: 0,
        trialsRecorded: 0
    };

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

    async function syncUserSubscription(email, subscription, plan) {
        const user = await User.findOne({ email });
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
    const listParams = { status: 'paid', limit: 100 };
    if (since) listParams.created = { gte: since };

    for await (const invoice of stripe.invoices.list(listParams)) {
        counters.scanned += 1;

        const lineItem = invoice.lines && invoice.lines.data && invoice.lines.data[0];
        const priceId = lineItem && lineItem.price && lineItem.price.id;
        const plan = planFromStripePriceId(priceId);
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

        const subscriptionId = getSubscriptionIdFromInvoice(invoice);

        const doc = {
            email,
            stripeCustomerId: invoice.customer || null,
            stripeInvoiceId: invoice.id,
            stripeSubscriptionId: subscriptionId,
            plan: plan || 'monthly',
            amountUSD: invoice.amount_paid != null ? invoice.amount_paid / 100 : 0,
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
        }

        // Backfill: si el Payment ya existía pero sin stripeSubscriptionId,
        // lo actualizamos ahora que sabemos cómo extraerlo.
        if (existing && subscriptionId && !existing.stripeSubscriptionId) {
            await Payment.updateOne(
                { stripeInvoiceId: invoice.id },
                { $set: { stripeSubscriptionId: subscriptionId } }
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

                    const subPriceId = sub.items && sub.items.data && sub.items.data[0]
                        ? sub.items.data[0].price && sub.items.data[0].price.id
                        : null;
                    const plan = planFromStripePriceId(subPriceId);
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
