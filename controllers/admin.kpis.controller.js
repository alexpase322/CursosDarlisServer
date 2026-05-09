const User = require('../models/User');
const Payment = require('../models/Payment');
const Commission = require('../models/Commission');
const Course = require('../models/Course');
const Post = require('../models/Post');

// GET /admin/kpis  → KPIs principales del negocio.
const getKpis = async (req, res) => {
    try {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const startOf7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const startOf30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        const [
            // Usuarias
            totalActiveUsers,
            totalPendingUsers,
            newUsersThisMonth,
            newUsersPrevMonth,

            // Suscripciones / membresía
            activeSubsCount,
            trialingSubsCount,
            pastDueSubsCount,
            canceledSubsCount,

            // Engagement
            usersActive7d,
            usersActive30d,

            // Pagos / Ingresos del mes
            grossThisMonthAgg,
            grossPrevMonthAgg,
            commissionsThisMonthAgg,

            // Catálogo
            coursesCount,
            postsCount,
            failedPaymentsThisMonth,

            // Ranking de planes
            plansBreakdown
        ] = await Promise.all([
            User.countDocuments({ role: { $ne: 'admin' }, status: 'active' }),
            User.countDocuments({ role: { $ne: 'admin' }, status: 'pending' }),
            User.countDocuments({ role: { $ne: 'admin' }, createdAt: { $gte: startOfMonth, $lt: endOfMonth } }),
            User.countDocuments({ role: { $ne: 'admin' }, createdAt: { $gte: startOfPrevMonth, $lt: startOfMonth } }),

            User.countDocuments({ 'subscription.status': 'active' }),
            User.countDocuments({ 'subscription.status': 'trialing' }),
            User.countDocuments({ 'subscription.status': 'past_due' }),
            User.countDocuments({ 'subscription.status': 'canceled' }),

            User.countDocuments({ lastActiveAt: { $gte: startOf7d } }),
            User.countDocuments({ lastActiveAt: { $gte: startOf30d } }),

            Payment.aggregate([
                { $match: { status: 'paid', amountUSD: { $gt: 0 }, paidAt: { $gte: startOfMonth, $lt: endOfMonth } } },
                { $group: { _id: null, total: { $sum: '$amountUSD' }, count: { $sum: 1 } } }
            ]),
            Payment.aggregate([
                { $match: { status: 'paid', amountUSD: { $gt: 0 }, paidAt: { $gte: startOfPrevMonth, $lt: startOfMonth } } },
                { $group: { _id: null, total: { $sum: '$amountUSD' }, count: { $sum: 1 } } }
            ]),
            Commission.aggregate([
                { $match: { status: { $ne: 'voided' }, createdAt: { $gte: startOfMonth, $lt: endOfMonth } } },
                { $group: { _id: null, total: { $sum: '$commissionAmountUSD' } } }
            ]),

            Course.countDocuments(),
            Post.countDocuments(),
            Payment.countDocuments({ status: 'failed', failedAt: { $gte: startOfMonth, $lt: endOfMonth } }),

            User.aggregate([
                { $match: { 'subscription.status': { $in: ['active', 'trialing'] } } },
                { $group: { _id: '$subscription.plan', n: { $sum: 1 } } }
            ])
        ]);

        const grossThisMonth = grossThisMonthAgg[0]?.total || 0;
        const grossPrevMonth = grossPrevMonthAgg[0]?.total || 0;
        const paymentsThisMonth = grossThisMonthAgg[0]?.count || 0;
        const commissionsThisMonth = commissionsThisMonthAgg[0]?.total || 0;
        const netThisMonth = grossThisMonth - commissionsThisMonth;
        const grossDelta = grossPrevMonth > 0 ? ((grossThisMonth - grossPrevMonth) / grossPrevMonth) * 100 : null;

        // ARPU (avg revenue per active user) basado en pagos del mes
        const arpu = totalActiveUsers > 0 ? (grossThisMonth / totalActiveUsers) : 0;

        // MRR estimado: suma de subs activas multiplicado por su precio normalizado a mensual
        const planPrices = { monthly: 50, quarterly: 120 / 3, yearly: 397 / 12 };
        const mrrAgg = await User.aggregate([
            { $match: { 'subscription.status': { $in: ['active', 'trialing'] } } },
            { $group: { _id: '$subscription.plan', n: { $sum: 1 } } }
        ]);
        let mrr = 0;
        for (const row of mrrAgg) {
            const price = planPrices[row._id] || 0;
            mrr += price * row.n;
        }

        // Churn (canceladas este mes / activas al inicio)
        const canceledThisMonth = await User.countDocuments({
            'subscription.status': 'canceled',
            updatedAt: { $gte: startOfMonth, $lt: endOfMonth }
        });
        const churnRate = totalActiveUsers > 0 ? (canceledThisMonth / totalActiveUsers) * 100 : 0;

        const plansMap = { monthly: 0, quarterly: 0, yearly: 0 };
        for (const p of plansBreakdown) if (p._id) plansMap[p._id] = p.n;

        // Tendencia diaria de pagos (últimos 30 días) para mini-chart
        const dailyAgg = await Payment.aggregate([
            { $match: { status: 'paid', amountUSD: { $gt: 0 }, paidAt: { $gte: startOf30d } } },
            { $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$paidAt' } },
                total: { $sum: '$amountUSD' },
                count: { $sum: 1 }
            } },
            { $sort: { _id: 1 } }
        ]);

        // Top 5 alumnas por progreso (no obligatorio pero útil)
        const topActive = await User.find({ status: 'active', role: { $ne: 'admin' } })
            .sort({ longestStreak: -1, currentStreak: -1 })
            .limit(5)
            .select('username avatar currentStreak longestStreak')
            .lean();

        res.json({
            users: {
                activeTotal: totalActiveUsers,
                pendingTotal: totalPendingUsers,
                newThisMonth: newUsersThisMonth,
                newPrevMonth: newUsersPrevMonth,
                active7d: usersActive7d,
                active30d: usersActive30d
            },
            subscriptions: {
                active: activeSubsCount,
                trialing: trialingSubsCount,
                pastDue: pastDueSubsCount,
                canceled: canceledSubsCount,
                churnRatePct: +churnRate.toFixed(2),
                canceledThisMonth
            },
            revenue: {
                grossThisMonth: +grossThisMonth.toFixed(2),
                grossPrevMonth: +grossPrevMonth.toFixed(2),
                grossDeltaPct: grossDelta != null ? +grossDelta.toFixed(1) : null,
                netThisMonth: +netThisMonth.toFixed(2),
                commissionsThisMonth: +commissionsThisMonth.toFixed(2),
                paymentsThisMonth,
                failedPaymentsThisMonth,
                mrr: +mrr.toFixed(2),
                arpu: +arpu.toFixed(2)
            },
            content: {
                coursesTotal: coursesCount,
                postsTotal: postsCount
            },
            plans: plansMap,
            dailyRevenue: dailyAgg.map(d => ({ date: d._id, total: +d.total.toFixed(2), count: d.count })),
            topActive
        });
    } catch (err) {
        console.error('getKpis', err);
        res.status(500).json({ message: 'Error al obtener KPIs' });
    }
};

module.exports = { getKpis };
