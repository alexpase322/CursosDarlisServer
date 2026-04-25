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
                totalPaidUSD: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amountUSD', 0] } },
                paymentsCount: { $sum: 1 }
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
                    ? { paidAt: p.lastPaidAt, amountUSD: p.lastAmountUSD, status: p.lastStatus, plan: p.lastPlan }
                    : null,
                totalPaidUSD: p.totalPaidUSD || 0,
                paymentsCount: p.paymentsCount || 0
            };
        });

        res.json({ items, total, page: parseInt(page), limit: parseInt(limit) });
    } catch (err) {
        console.error('listSubscriptions', err);
        res.status(500).json({ message: 'Error al listar suscripciones' });
    }
};

module.exports = { listSubscriptions };
