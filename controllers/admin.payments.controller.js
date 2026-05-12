const Payment = require('../models/Payment');
const User = require('../models/User');

// Determina la "fuente" del pago: stripe / manual / trial
const sourceOf = (p) => {
    if (!p?.stripeInvoiceId) return 'unknown';
    if (p.stripeInvoiceId.startsWith('manual_')) return 'manual';
    if (p.stripeInvoiceId.startsWith('trial_')) return 'trial';
    return 'stripe';
};

// GET /admin/payments
// Lista de pagos con filtros:
//   month=YYYY-MM     (default: mes actual)
//   status=paid|failed|refunded
//   plan=monthly|quarterly|yearly
//   source=stripe|manual|trial
//   q=texto en email
//   page, limit (default 50)
const listPayments = async (req, res) => {
    try {
        const {
            month,
            status,
            plan,
            source,
            q,
            page = 1,
            limit = 50,
            sort = '-paidAt'
        } = req.query;

        // Rango temporal
        let from, to;
        if (month && /^\d{4}-\d{2}$/.test(month)) {
            const [y, m] = month.split('-').map(Number);
            from = new Date(y, m - 1, 1);
            to = new Date(y, m, 1);
        } else {
            const now = new Date();
            from = new Date(now.getFullYear(), now.getMonth(), 1);
            to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        }

        const filter = { paidAt: { $gte: from, $lt: to } };
        if (status) filter.status = status;
        if (plan) filter.plan = plan;
        if (q) filter.email = { $regex: q, $options: 'i' };

        // Filtro por source (se aplica como condición sobre stripeInvoiceId)
        if (source === 'manual') filter.stripeInvoiceId = { $regex: '^manual_' };
        else if (source === 'trial') filter.stripeInvoiceId = { $regex: '^trial_' };
        else if (source === 'stripe') filter.stripeInvoiceId = { $regex: '^in_' };

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [items, total, allMatching] = await Promise.all([
            Payment.find(filter).sort(sort).skip(skip).limit(parseInt(limit)).lean(),
            Payment.countDocuments(filter),
            // Para resumen sin paginar (totales y desgloses)
            Payment.find(filter).lean()
        ]);

        // Buscar nombre de cada alumna por email
        const emails = [...new Set(items.map(p => p.email).filter(Boolean))];
        const users = await User.find({ email: { $in: emails.map(e => new RegExp(`^${e}$`, 'i')) } })
            .select('email username avatar status').lean();
        const userByEmail = new Map(users.map(u => [(u.email || '').toLowerCase().trim(), u]));

        const enriched = items.map(p => {
            const u = userByEmail.get((p.email || '').toLowerCase().trim()) || null;
            return {
                ...p,
                source: sourceOf(p),
                user: u ? { _id: u._id, username: u.username, avatar: u.avatar, status: u.status } : null
            };
        });

        // Resumen agregado (siempre sobre TODO el conjunto filtrado, no paginado)
        const summary = {
            totalCount: allMatching.length,
            byStatus: { paid: 0, failed: 0, refunded: 0 },
            byPlan: { monthly: 0, quarterly: 0, yearly: 0 },
            bySource: { stripe: 0, manual: 0, trial: 0, unknown: 0 },
            totalUSD: 0,
            paidUSD: 0,
            paidCount: 0,
            paidNonZeroCount: 0,
            failedCount: 0,
            refundedCount: 0,
            zeroCount: 0,
            duplicateSubscriptions: []
        };

        // Detector de duplicados: misma stripeSubscriptionId con > 1 paid en este rango (cobro doble)
        const subPaidCount = new Map();

        for (const p of allMatching) {
            summary.byStatus[p.status] = (summary.byStatus[p.status] || 0) + 1;
            if (p.plan && summary.byPlan[p.plan] !== undefined) summary.byPlan[p.plan] += 1;
            const src = sourceOf(p);
            summary.bySource[src] = (summary.bySource[src] || 0) + 1;
            summary.totalUSD += p.amountUSD || 0;

            if (p.status === 'paid') {
                summary.paidUSD += p.amountUSD || 0;
                summary.paidCount += 1;
                if ((p.amountUSD || 0) > 0) summary.paidNonZeroCount += 1;
                else summary.zeroCount += 1;
                if (p.stripeSubscriptionId) {
                    subPaidCount.set(p.stripeSubscriptionId, (subPaidCount.get(p.stripeSubscriptionId) || 0) + 1);
                }
            } else if (p.status === 'failed') summary.failedCount += 1;
            else if (p.status === 'refunded') summary.refundedCount += 1;
        }

        // Buscar subs con más de 1 cobro pagado en el mes (probable duplicado)
        for (const [subId, count] of subPaidCount.entries()) {
            if (count > 1) summary.duplicateSubscriptions.push({ subId, count });
        }

        summary.totalUSD = +summary.totalUSD.toFixed(2);
        summary.paidUSD = +summary.paidUSD.toFixed(2);

        res.json({
            from, to, month: `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}`,
            items: enriched,
            total,
            page: parseInt(page),
            limit: parseInt(limit),
            summary
        });
    } catch (err) {
        console.error('listPayments', err);
        res.status(500).json({ message: 'Error al listar pagos' });
    }
};

// GET /admin/payments/diagnose
// Diagnóstico de inconsistencias: usuarias activas con plan vacío, subs duplicadas, etc.
const diagnose = async (req, res) => {
    try {
        const activeWithoutPlan = await User.find({
            'subscription.status': { $in: ['active', 'trialing'] },
            $or: [
                { 'subscription.plan': { $in: [null, ''] } },
                { 'subscription.plan': { $exists: false } }
            ],
            role: { $ne: 'admin' }
        }).select('username email subscription').lean();

        // Pagos duplicados por stripeInvoiceId (no debería pasar por el unique sparse, pero por si acaso)
        const dupInvoices = await Payment.aggregate([
            { $match: { stripeInvoiceId: { $ne: null } } },
            { $group: { _id: '$stripeInvoiceId', n: { $sum: 1 } } },
            { $match: { n: { $gt: 1 } } }
        ]);

        // Subs con más de 1 invoice paid en el mes actual
        const now = new Date();
        const from = new Date(now.getFullYear(), now.getMonth(), 1);
        const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const dupSubsMonth = await Payment.aggregate([
            { $match: {
                status: 'paid',
                amountUSD: { $gt: 0 },
                paidAt: { $gte: from, $lt: to },
                stripeSubscriptionId: { $nin: [null, ''] },
                stripeInvoiceId: { $not: /^manual_|^trial_/ }
            }},
            { $group: { _id: '$stripeSubscriptionId', n: { $sum: 1 }, emails: { $addToSet: '$email' }, total: { $sum: '$amountUSD' } } },
            { $match: { n: { $gt: 1 } } }
        ]);

        res.json({
            activeWithoutPlan: activeWithoutPlan.map(u => ({
                _id: u._id, username: u.username, email: u.email,
                subscription: u.subscription
            })),
            duplicateInvoiceIds: dupInvoices,
            duplicateSubscriptionsThisMonth: dupSubsMonth
        });
    } catch (err) {
        console.error('diagnose', err);
        res.status(500).json({ message: 'Error en diagnóstico' });
    }
};

module.exports = { listPayments, diagnose };
