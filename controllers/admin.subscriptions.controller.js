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
// Para cada usuario sin subscription pero con un Payment.stripeSubscriptionId,
// trae la sub desde Stripe y le asigna User.subscription. NO toca usuarios que
// tengan subscription manual ni borra nada — solo rellena lo que falta.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const backfillSubscriptionsFromPayments = async (req, res) => {
    try {
        if (!process.env.STRIPE_SECRET_KEY) {
            return res.status(500).json({ message: 'Falta STRIPE_SECRET_KEY' });
        }

        // Usuarios sin subscription (o con status vacío) y rol != admin.
        const candidates = await User.find({
            role: { $ne: 'admin' },
            $or: [
                { subscription: { $exists: false } },
                { subscription: null },
                { 'subscription.id': { $in: [null, ''] } },
                { 'subscription.status': { $in: [null, ''] } }
            ]
        }).lean();

        const stats = { scanned: candidates.length, updated: 0, noPayment: 0, noStripeSub: 0, errors: 0 };

        for (const u of candidates) {
            const email = (u.email || '').toLowerCase().trim();
            if (!email) { stats.noPayment += 1; continue; }

            const lastPaid = await Payment.findOne({
                email,
                status: 'paid',
                stripeSubscriptionId: { $nin: [null, ''] },
                stripeInvoiceId: { $not: /^manual_/ } // ignoramos pagos manuales
            }).sort({ paidAt: -1 }).lean();

            if (!lastPaid) { stats.noPayment += 1; continue; }
            if (!lastPaid.stripeSubscriptionId) { stats.noStripeSub += 1; continue; }

            try {
                const sub = await stripe.subscriptions.retrieve(lastPaid.stripeSubscriptionId);
                await User.updateOne(
                    { _id: u._id },
                    { $set: {
                        subscription: {
                            id: sub.id,
                            customerId: sub.customer,
                            status: sub.status,
                            plan: lastPaid.plan,
                            currentPeriodEnd: sub.current_period_end
                                ? new Date(sub.current_period_end * 1000)
                                : null
                        }
                    } }
                );
                stats.updated += 1;
            } catch (err) {
                console.error(`backfill ${email}:`, err.message);
                stats.errors += 1;
            }
        }

        res.json({ ok: true, stats });
    } catch (err) {
        console.error('backfillSubscriptionsFromPayments', err);
        res.status(500).json({ message: 'Error en backfill' });
    }
};

module.exports = { listSubscriptions, registerManualPayment, backfillSubscriptionsFromPayments };
