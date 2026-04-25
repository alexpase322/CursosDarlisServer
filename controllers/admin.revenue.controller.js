const Payment = require('../models/Payment');
const Commission = require('../models/Commission');

// GET /admin/revenue/monthly?from=YYYY-MM&to=YYYY-MM&plan=monthly|quarterly|yearly
// Devuelve series mensuales: bruto cobrado (Payments paid), comisiones generadas
// (Commissions no anuladas) y neto = bruto - comisiones. Desglose por plan.
const getMonthlyRevenue = async (req, res) => {
    try {
        const { from, to, plan } = req.query;

        const now = new Date();
        const defaultFrom = new Date(now.getFullYear(), now.getMonth() - 11, 1);
        const defaultTo = new Date(now.getFullYear(), now.getMonth() + 1, 1);

        const parseMonth = (s, fallback) => {
            if (!s) return fallback;
            const [y, m] = s.split('-').map(Number);
            if (!y || !m) return fallback;
            return new Date(y, m - 1, 1);
        };
        const fromDate = parseMonth(from, defaultFrom);
        const toDate = parseMonth(to, defaultTo);

        const matchPayments = {
            status: 'paid',
            amountUSD: { $gt: 0 },
            paidAt: { $gte: fromDate, $lt: toDate }
        };
        if (plan) matchPayments.plan = plan;

        const grossAgg = await Payment.aggregate([
            { $match: matchPayments },
            { $group: {
                _id: {
                    y: { $year: '$paidAt' },
                    m: { $month: '$paidAt' },
                    plan: '$plan'
                },
                gross: { $sum: '$amountUSD' },
                count: { $sum: 1 }
            } }
        ]);

        const matchCommissions = {
            status: { $ne: 'voided' },
            createdAt: { $gte: fromDate, $lt: toDate }
        };
        if (plan) matchCommissions.plan = plan;

        const commAgg = await Commission.aggregate([
            { $match: matchCommissions },
            { $group: {
                _id: {
                    y: { $year: '$createdAt' },
                    m: { $month: '$createdAt' },
                    plan: '$plan'
                },
                commissions: { $sum: '$commissionAmountUSD' },
                paidOut: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$commissionAmountUSD', 0] } }
            } }
        ]);

        const buckets = new Map();
        const keyOf = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
        const ensureBucket = (y, m) => {
            const k = keyOf(y, m);
            if (!buckets.has(k)) {
                buckets.set(k, {
                    month: k,
                    gross: 0,
                    paymentsCount: 0,
                    commissions: 0,
                    commissionsPaidOut: 0,
                    net: 0,
                    byPlan: {
                        monthly:   { gross: 0, commissions: 0, net: 0, count: 0 },
                        quarterly: { gross: 0, commissions: 0, net: 0, count: 0 },
                        yearly:    { gross: 0, commissions: 0, net: 0, count: 0 }
                    }
                });
            }
            return buckets.get(k);
        };

        for (const row of grossAgg) {
            const b = ensureBucket(row._id.y, row._id.m);
            b.gross += row.gross;
            b.paymentsCount += row.count;
            const p = row._id.plan;
            if (b.byPlan[p]) {
                b.byPlan[p].gross += row.gross;
                b.byPlan[p].count += row.count;
            }
        }
        for (const row of commAgg) {
            const b = ensureBucket(row._id.y, row._id.m);
            b.commissions += row.commissions;
            b.commissionsPaidOut += row.paidOut;
            const p = row._id.plan;
            if (b.byPlan[p]) {
                b.byPlan[p].commissions += row.commissions;
            }
        }

        // Rellenar meses sin actividad para que el frontend tenga la serie completa.
        const cursor = new Date(fromDate);
        while (cursor < toDate) {
            ensureBucket(cursor.getFullYear(), cursor.getMonth() + 1);
            cursor.setMonth(cursor.getMonth() + 1);
        }

        const items = Array.from(buckets.values())
            .map(b => {
                b.net = Number((b.gross - b.commissions).toFixed(2));
                b.gross = Number(b.gross.toFixed(2));
                b.commissions = Number(b.commissions.toFixed(2));
                b.commissionsPaidOut = Number(b.commissionsPaidOut.toFixed(2));
                for (const p of Object.keys(b.byPlan)) {
                    b.byPlan[p].net = Number((b.byPlan[p].gross - b.byPlan[p].commissions).toFixed(2));
                    b.byPlan[p].gross = Number(b.byPlan[p].gross.toFixed(2));
                    b.byPlan[p].commissions = Number(b.byPlan[p].commissions.toFixed(2));
                }
                return b;
            })
            .sort((a, b) => a.month.localeCompare(b.month));

        const totals = items.reduce((acc, b) => {
            acc.gross += b.gross;
            acc.commissions += b.commissions;
            acc.commissionsPaidOut += b.commissionsPaidOut;
            acc.net += b.net;
            acc.paymentsCount += b.paymentsCount;
            return acc;
        }, { gross: 0, commissions: 0, commissionsPaidOut: 0, net: 0, paymentsCount: 0 });

        for (const k of Object.keys(totals)) {
            if (typeof totals[k] === 'number') totals[k] = Number(totals[k].toFixed(2));
        }

        res.json({
            from: fromDate,
            to: toDate,
            plan: plan || null,
            items,
            totals
        });
    } catch (err) {
        console.error('getMonthlyRevenue', err);
        res.status(500).json({ message: 'Error al calcular ingresos' });
    }
};

module.exports = { getMonthlyRevenue };
