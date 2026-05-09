const User = require('../models/User');
const Payment = require('../models/Payment');

// GET /admin/subscriptions
// Lista usuarios (rol != admin) con su info de suscripción y último pago.
// Soporta filtros: q (texto en username/email), status (active|trialing|past_due|canceled|none),
// plan (monthly|quarterly|yearly), sort, page, limit.
const listSubscriptions = async (req, res) => {
    try {
        const {
            q,
            status,
            plan,
            sort = '-createdAt',
            page = 1,
            limit = 25
        } = req.query;

        const filter = { role: { $ne: 'admin' } };
        if (q) {
            filter.$or = [
                { username: { $regex: q, $options: 'i' } },
                { email: { $regex: q, $options: 'i' } }
            ];
        }
        if (status) {
            if (status === 'none') {
                filter.$and = [
                    ...(filter.$and || []),
                    { $or: [{ subscription: { $exists: false } }, { 'subscription.status': { $in: [null, ''] } }] }
                ];
            } else {
                filter['subscription.status'] = status;
            }
        }
        if (plan) filter['subscription.plan'] = plan;

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [users, total] = await Promise.all([
            User.find(filter)
                .select('username email avatar role status partnerLevel subscription createdAt')
                .sort(sort)
                .skip(skip)
                .limit(parseInt(limit))
                .lean(),
            User.countDocuments(filter)
        ]);

        // Enriquecer cada usuario con su último Payment (para mostrar fecha y monto reales).
        const emails = users.map(u => (u.email || '').toLowerCase().trim()).filter(Boolean);
        const lastPayments = await Payment.aggregate([
            { $match: { email: { $in: emails } } },
            { $sort: { paidAt: -1 } },
            { $group: {
                _id: '$email',
                lastPaidAt: { $first: '$paidAt' },
                lastAmountUSD: { $first: '$amountUSD' },
                lastStatus: { $first: '$status' },
                lastPlan: { $first: '$plan' },
                lastFailureReason: { $first: '$failureReason' },
                totalPaidUSD: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amountUSD', 0] } },
                paymentsCount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
                failedCount: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }
            }}
        ]);
        const paymentsByEmail = new Map(lastPayments.map(p => [p._id, p]));

        const items = users.map(u => {
            const p = paymentsByEmail.get((u.email || '').toLowerCase().trim()) || {};
            return {
                _id: u._id,
                username: u.username,
                email: u.email,
                avatar: u.avatar,
                userStatus: u.status,
                partnerLevel: u.partnerLevel,
                createdAt: u.createdAt,
                subscription: u.subscription || null,
                lastPayment: p.lastPaidAt
                    ? { paidAt: p.lastPaidAt, amountUSD: p.lastAmountUSD, status: p.lastStatus, plan: p.lastPlan, failureReason: p.lastFailureReason || null }
                    : null,
                totalPaidUSD: p.totalPaidUSD || 0,
                paymentsCount: p.paymentsCount || 0,
                failedCount: p.failedCount || 0
            };
        });

        res.json({ items, total, page: parseInt(page), limit: parseInt(limit) });
    } catch (err) {
        console.error('listSubscriptions', err);
        res.status(500).json({ message: 'Error al listar suscripciones' });
    }
};

// POST /admin/subscriptions/:userId/manual-payment
// Registra un pago "fuera de Stripe" (transferencia, beacons, etc.) para que la alumna
// pueda solicitar afiliarse. Crea un Payment con id sintético `manual_<userId>_<ts>` y,
// opcionalmente, sincroniza User.subscription para que el panel la muestre como activa.
const PLAN_DURATIONS_DAYS = { monthly: 30, quarterly: 90, yearly: 365 };
const PLAN_PRICES_USD = { monthly: 50, quarterly: 120, yearly: 397 };

const registerManualPayment = async (req, res) => {
    try {
        const { userId } = req.params;
        const {
            plan = 'monthly',
            amountUSD,
            paidAt,
            method = 'transfer',
            note = '',
            updateSubscription = true
        } = req.body || {};

        if (!['monthly', 'quarterly', 'yearly'].includes(plan)) {
            return res.status(400).json({ message: 'Plan inválido' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'Usuaria no encontrada' });

        const paid = paidAt ? new Date(paidAt) : new Date();
        const amt = Number.isFinite(Number(amountUSD)) ? Number(amountUSD) : PLAN_PRICES_USD[plan];

        const invoiceId = `manual_${user._id}_${paid.getTime()}`;

        const payment = await Payment.create({
            email: (user.email || '').toLowerCase().trim(),
            stripeInvoiceId: invoiceId,
            plan,
            amountUSD: amt,
            status: 'paid',
            paidAt: paid
        });

        if (updateSubscription) {
            const days = PLAN_DURATIONS_DAYS[plan] || 30;
            const periodEnd = new Date(paid.getTime() + days * 24 * 60 * 60 * 1000);
            user.subscription = {
                ...(user.subscription || {}),
                id: user.subscription?.id || `manual_${user._id}`,
                status: 'active',
                plan,
                currentPeriodEnd: periodEnd,
                customerId: user.subscription?.customerId
            };
            await user.save();
        }

        res.json({
            ok: true,
            payment,
            user: { _id: user._id, subscription: user.subscription },
            meta: { method, note }
        });
    } catch (err) {
        console.error('registerManualPayment', err);
        if (err.code === 11000) {
            return res.status(409).json({ message: 'Ya existe un pago con ese identificador' });
        }
        res.status(500).json({ message: 'Error al registrar pago manual' });
    }
};

// POST /admin/subscriptions/backfill-from-payments
// Reconcilia por usuaria contra Stripe:
//   1) Encuentra el stripeCustomerId (de User.subscription o último Payment real)
//   2) Lista invoices del customer en Stripe (desde el piso 2026-03-01)
//   3) Upsert por stripeInvoiceId — actualiza estado (paid/failed/refunded) y monto.
//      Esto detecta resuscripciones después de cancelar, intentos fallidos que ya
//      pagaron, refunds, etc.
//   4) Refresca User.subscription con la sub activa más reciente.
// NO toca pagos manuales (`manual_*`), NO borra Payments existentes.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { inferPlan } = require('../config/affiliateConfig');

const PAID_AT_FLOOR = new Date('2026-03-01T00:00:00.000Z');
const PAID_AT_FLOOR_UNIX = Math.floor(PAID_AT_FLOOR.getTime() / 1000);
const ACTIVE_SUB_STATUSES = ['active', 'trialing', 'past_due'];

const getSubscriptionIdFromInvoice = (invoice) => {
    if (!invoice) return null;
    if (invoice.subscription) return invoice.subscription;
    if (invoice.parent?.subscription_details?.subscription) return invoice.parent.subscription_details.subscription;
    const lines = invoice.lines?.data || [];
    for (const li of lines) {
        if (li.subscription) return li.subscription;
        if (li.parent?.subscription_item_details?.subscription) return li.parent.subscription_item_details.subscription;
    }
    return null;
};

async function reconcileOneUser(user, stats, log) {
    const email = (user.email || '').toLowerCase().trim();
    if (!email) { stats.noEmail += 1; return; }

    // 1) Encontrar customerId: priorizamos User.subscription, fallback al último Payment real.
    let customerId = user.subscription?.customerId || null;
    if (!customerId) {
        const lastReal = await Payment.findOne({
            email,
            stripeCustomerId: { $nin: [null, ''] },
            stripeInvoiceId: { $not: /^manual_/ }
        }).sort({ paidAt: -1 }).lean();
        customerId = lastReal?.stripeCustomerId || null;
    }
    // Último intento: buscar customer en Stripe por email.
    if (!customerId) {
        try {
            const list = await stripe.customers.list({ email, limit: 1 });
            customerId = list.data?.[0]?.id || null;
        } catch { /* noop */ }
    }
    if (!customerId) { stats.noCustomer += 1; return; }

    // 2) Listar invoices desde el piso. Iteramos paginado.
    let invoices = [];
    try {
        for await (const inv of stripe.invoices.list({
            customer: customerId,
            limit: 100,
            created: { gte: PAID_AT_FLOOR_UNIX }
        })) {
            invoices.push(inv);
        }
    } catch (err) {
        log(`reconcile ${email} invoices:`, err.message);
        stats.errors += 1;
        return;
    }

    // 3) Upsert cada invoice
    for (const invoice of invoices) {
        try {
            const lineItem = invoice.lines?.data?.[0];
            const priceId = lineItem?.price?.id;
            const subscriptionId = getSubscriptionIdFromInvoice(invoice);

            const paidAt = invoice.status_transitions?.paid_at
                ? new Date(invoice.status_transitions.paid_at * 1000)
                : new Date(invoice.created * 1000);
            if (paidAt < PAID_AT_FLOOR) continue;

            // Determinar status real
            let status = 'failed';
            let amountUSD = (invoice.amount_due ?? 0) / 100;
            let refundedFlag = false;
            if (invoice.status === 'paid' && invoice.amount_paid > 0) {
                status = 'paid';
                amountUSD = invoice.amount_paid / 100;
                if (invoice.charge) {
                    try {
                        const charge = await stripe.charges.retrieve(invoice.charge);
                        if (charge?.refunded) { status = 'refunded'; refundedFlag = true; }
                    } catch { /* noop */ }
                }
            } else if (invoice.status === 'paid' && invoice.amount_paid === 0) {
                // Trial invoice, marcar como paid amount 0
                status = 'paid';
                amountUSD = 0;
            } else if (['open', 'uncollectible'].includes(invoice.status)) {
                status = 'failed';
            } else if (invoice.status === 'void') {
                continue; // ignorar voids
            }

            const plan = inferPlan({ priceId, lineItem, amountUSD });

            const set = {
                email,
                stripeCustomerId: invoice.customer || customerId,
                stripeInvoiceId: invoice.id,
                stripeSubscriptionId: subscriptionId || null,
                plan: plan || 'monthly',
                amountUSD,
                status,
                paidAt,
                refundedAt: refundedFlag ? new Date() : null,
                failedAt: status === 'failed' ? (invoice.status_transitions?.finalized_at
                    ? new Date(invoice.status_transitions.finalized_at * 1000) : new Date()) : null,
                failureReason: status === 'failed'
                    ? (invoice.last_finalization_error?.message || lineItem?.description || 'Pago rechazado')
                    : null,
                attemptCount: invoice.attempt_count || 0,
                nextAttemptAt: invoice.next_payment_attempt
                    ? new Date(invoice.next_payment_attempt * 1000) : null
            };

            const existing = await Payment.findOne({ stripeInvoiceId: invoice.id }).lean();
            if (!existing) {
                await Payment.create(set);
                stats.paymentsInserted += 1;
                if (status === 'paid' && amountUSD > 0) stats.paymentsPaidNew += 1;
            } else {
                // Detectar transiciones (failed → paid, paid → refunded, etc.)
                const wasNotPaid = existing.status !== 'paid';
                const wasNotRefunded = existing.status !== 'refunded';
                const update = {};
                // Solo actualizamos si el nuevo status es "más definitivo".
                const rank = { failed: 1, paid: 2, refunded: 3 };
                if ((rank[status] || 0) >= (rank[existing.status] || 0)) {
                    Object.assign(update, set);
                }
                // Backfill de subscriptionId si vacío
                if (!existing.stripeSubscriptionId && subscriptionId) {
                    update.stripeSubscriptionId = subscriptionId;
                }
                if (Object.keys(update).length > 0) {
                    await Payment.updateOne({ _id: existing._id }, { $set: update });
                    stats.paymentsUpdated += 1;
                    if (wasNotPaid && status === 'paid') stats.statusFlippedToPaid += 1;
                    if (wasNotRefunded && status === 'refunded') stats.statusFlippedToRefunded += 1;
                }
            }
        } catch (err) {
            log(`reconcile invoice ${invoice.id}:`, err.message);
            stats.errors += 1;
        }
    }

    // 4) Refrescar User.subscription con la sub activa más reciente del customer.
    try {
        const subList = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
        const subs = (subList.data || [])
            .filter(s => ACTIVE_SUB_STATUSES.includes(s.status) || s.status === 'canceled')
            .sort((a, b) => (b.current_period_end || 0) - (a.current_period_end || 0));
        const best = subs.find(s => ACTIVE_SUB_STATUSES.includes(s.status)) || subs[0];

        if (best) {
            const subItem = best.items?.data?.[0];
            const subPriceId = subItem?.price?.id;
            const subAmountUSD = subItem?.price?.unit_amount != null ? subItem.price.unit_amount / 100 : null;
            const plan = inferPlan({ priceId: subPriceId, lineItem: subItem, amountUSD: subAmountUSD });

            const newSub = {
                id: best.id,
                customerId: best.customer,
                status: best.status,
                plan: plan || user.subscription?.plan || null,
                currentPeriodEnd: best.current_period_end ? new Date(best.current_period_end * 1000) : null
            };
            const prev = user.subscription || {};
            if (prev.id !== newSub.id || prev.status !== newSub.status ||
                String(prev.currentPeriodEnd || '') !== String(newSub.currentPeriodEnd || '')) {
                await User.updateOne({ _id: user._id }, { $set: { subscription: newSub } });
                stats.subscriptionsUpdated += 1;
            }
        }
    } catch (err) {
        log(`reconcile sub ${email}:`, err.message);
        stats.errors += 1;
    }
}

const backfillSubscriptionsFromPayments = async (req, res) => {
    try {
        if (!process.env.STRIPE_SECRET_KEY) {
            return res.status(500).json({ message: 'Falta STRIPE_SECRET_KEY' });
        }

        const stats = {
            scanned: 0,
            paymentsInserted: 0,
            paymentsUpdated: 0,
            paymentsPaidNew: 0,
            statusFlippedToPaid: 0,
            statusFlippedToRefunded: 0,
            subscriptionsUpdated: 0,
            noEmail: 0,
            noCustomer: 0,
            errors: 0
        };

        const candidates = await User.find({ role: { $ne: 'admin' } }).lean();
        stats.scanned = candidates.length;

        const log = (...a) => console.log('[reconcile]', ...a);
        for (const u of candidates) {
            await reconcileOneUser(u, stats, log);
        }

        res.json({ ok: true, stats });
    } catch (err) {
        console.error('backfillSubscriptionsFromPayments', err);
        res.status(500).json({ message: 'Error en reconciliación' });
    }
};

module.exports = { listSubscriptions, registerManualPayment, backfillSubscriptionsFromPayments };
