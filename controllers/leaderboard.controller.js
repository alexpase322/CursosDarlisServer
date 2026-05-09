const Commission = require('../models/Commission');
const User = require('../models/User');

// GET /leaderboard/affiliates?month=YYYY-MM&limit=10
// Top afiliadas por comisiones generadas (no anuladas) en el mes pedido.
// Si no se pasa mes, usa el mes actual.
const getAffiliatesLeaderboard = async (req, res) => {
    try {
        const { month, limit = 10 } = req.query;
        let monthStart, monthEnd;
        if (month && /^\d{4}-\d{2}$/.test(month)) {
            const [y, m] = month.split('-').map(Number);
            monthStart = new Date(y, m - 1, 1);
            monthEnd = new Date(y, m, 1);
        } else {
            const now = new Date();
            monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
            monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        }

        const lim = Math.min(parseInt(limit) || 10, 50);

        const agg = await Commission.aggregate([
            { $match: {
                status: { $ne: 'voided' },
                createdAt: { $gte: monthStart, $lt: monthEnd }
            }},
            { $group: {
                _id: '$affiliate',
                totalUSD: { $sum: '$commissionAmountUSD' },
                count: { $sum: 1 },
                referralsSet: { $addToSet: '$referredUser' }
            }},
            { $project: {
                totalUSD: 1, count: 1,
                uniqueReferrals: { $size: '$referralsSet' }
            }},
            { $sort: { totalUSD: -1 } },
            { $limit: lim }
        ]);

        const ids = agg.map(a => a._id);
        const users = await User.find({ _id: { $in: ids } })
            .select('username avatar partnerLevel').lean();
        const byId = new Map(users.map(u => [String(u._id), u]));

        const items = agg.map((a, idx) => ({
            rank: idx + 1,
            user: byId.get(String(a._id)) || { _id: a._id, username: 'Afiliada' },
            totalUSD: +a.totalUSD.toFixed(2),
            commissionsCount: a.count,
            uniqueReferrals: a.uniqueReferrals
        }));

        // Posición del usuario autenticado (si es afiliada y no está en el top).
        let myPosition = null;
        if (req.user && req.user._id) {
            const myIdx = agg.findIndex(a => String(a._id) === String(req.user._id));
            if (myIdx === -1) {
                // Hacer query separada con todos para encontrar mi rank.
                const all = await Commission.aggregate([
                    { $match: {
                        status: { $ne: 'voided' },
                        createdAt: { $gte: monthStart, $lt: monthEnd }
                    }},
                    { $group: { _id: '$affiliate', totalUSD: { $sum: '$commissionAmountUSD' } } },
                    { $sort: { totalUSD: -1 } }
                ]);
                const i = all.findIndex(a => String(a._id) === String(req.user._id));
                if (i >= 0) {
                    myPosition = { rank: i + 1, totalUSD: +all[i].totalUSD.toFixed(2), totalAffiliates: all.length };
                }
            } else {
                myPosition = { rank: myIdx + 1, totalUSD: +agg[myIdx].totalUSD.toFixed(2) };
            }
        }

        res.json({
            month: `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}`,
            items,
            myPosition
        });
    } catch (err) {
        console.error('getAffiliatesLeaderboard', err);
        res.status(500).json({ message: 'Error al obtener leaderboard' });
    }
};

module.exports = { getAffiliatesLeaderboard };
