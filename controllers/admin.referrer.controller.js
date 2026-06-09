// Reasignación de referidora (afiliación) de una alumna.
// - Cambia user.referredBy
// - Reasigna las Commission existentes a la nueva afiliada (o las anula si quitas referidora)
// - Genera las comisiones que faltan para los Payments paid del usuario,
//   con createdAt = payment.paidAt (BACKDATED) para que aparezcan en el mes correcto
//   en los reportes mensuales (ingresos, leaderboard, etc.)
// - Recalcula los stats agregados (referralStats) de la afiliada vieja Y la nueva.

const User = require('../models/User');
const Payment = require('../models/Payment');
const Commission = require('../models/Commission');
const { rates } = require('../config/affiliateConfig');
const { evaluateMilestones } = require('../services/engagementService');

// Recalcula referralStats almacenados desde la verdad: Users + Commissions.
async function recomputeAffiliateStats(affiliateId) {
    if (!affiliateId) return;
    const [totalReferred, activeReferred, commAgg] = await Promise.all([
        User.countDocuments({ referredBy: affiliateId }),
        User.countDocuments({
            referredBy: affiliateId,
            'subscription.status': { $in: ['active', 'trialing', 'past_due'] }
        }),
        Commission.aggregate([
            { $match: { affiliate: affiliateId } },
            { $group: { _id: '$status', total: { $sum: '$commissionAmountUSD' } } }
        ])
    ]);
    const byStatus = { available: 0, pending: 0, paid: 0, voided: 0 };
    for (const s of commAgg) byStatus[s._id] = s.total;

    await User.updateOne({ _id: affiliateId }, { $set: {
        'referralStats.totalReferred': totalReferred,
        'referralStats.activeReferred': activeReferred,
        'referralStats.totalEarnedUSD': +(byStatus.available + byStatus.pending + byStatus.paid).toFixed(2),
        'referralStats.pendingUSD':     +(byStatus.available + byStatus.pending).toFixed(2),
        'referralStats.paidUSD':        +byStatus.paid.toFixed(2)
    } });

    // Re-evaluar logros del afiliado tras cambio de stats.
    evaluateMilestones(affiliateId).catch(() => {});
}

// PUT /admin/users/:userId/referrer  body: { referrerId: 'id' | null }
const reassignReferrer = async (req, res) => {
    try {
        const { userId } = req.params;
        const { referrerId } = req.body || {};

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'Usuaria no encontrada' });

        let newReferrer = null;
        if (referrerId) {
            if (String(referrerId) === String(userId)) {
                return res.status(400).json({ message: 'No puede ser su propia referidora' });
            }
            newReferrer = await User.findById(referrerId).select('username email partnerLevel status');
            if (!newReferrer) return res.status(404).json({ message: 'Nueva referidora no encontrada' });
            if (newReferrer.partnerLevel < 2) {
                return res.status(400).json({ message: 'La nueva referidora debe ser Partner (nivel 2 o superior)' });
            }
        }

        const oldReferrerId = user.referredBy;
        const oldReferrerStr = oldReferrerId ? String(oldReferrerId) : null;
        const newReferrerStr = newReferrer ? String(newReferrer._id) : null;

        if (oldReferrerStr === newReferrerStr) {
            return res.json({ ok: true, noop: true, message: 'No hubo cambios' });
        }

        // Paso 1: cambiar referredBy del user
        user.referredBy = newReferrer ? newReferrer._id : null;
        await user.save();

        const stats = { reassigned: 0, voided: 0, unchanged: 0, created: 0, oldReferrerId: oldReferrerStr, newReferrerId: newReferrerStr };

        // Paso 2: reasignar Commissions existentes
        const existingCommissions = await Commission.find({ referredUser: userId });
        for (const c of existingCommissions) {
            if (!newReferrer) {
                // Sin nueva referidora → anular (la academia se queda con el cobro)
                if (c.status !== 'voided') {
                    c.status = 'voided';
                    await c.save();
                    stats.voided += 1;
                } else {
                    stats.unchanged += 1;
                }
            } else if (String(c.affiliate) !== newReferrerStr) {
                c.affiliate = newReferrer._id;
                if (c.status === 'voided') c.status = 'available'; // resucitar
                await c.save();
                stats.reassigned += 1;
            } else {
                stats.unchanged += 1;
            }
        }

        // Paso 3: si hay nueva afiliada, crear comisiones faltantes para Payments paid
        //         con createdAt BACKDATED a payment.paidAt (para reportes mensuales correctos)
        if (newReferrer) {
            const email = (user.email || '').toLowerCase().trim();
            const payments = await Payment.find({
                email,
                status: 'paid',
                amountUSD: { $gt: 0 },
                stripeInvoiceId: { $not: /^trial_/ }
            }).lean();

            for (const p of payments) {
                const exists = await Commission.findOne({ stripeInvoiceId: p.stripeInvoiceId });
                if (exists) continue;

                const plan = p.plan || 'monthly';
                const rate = rates[plan];
                if (!rate) continue;

                try {
                    const commissionAmountUSD = +(p.amountUSD * rate).toFixed(2);
                    const paidAt = p.paidAt || new Date();
                    await Commission.create({
                        affiliate: newReferrer._id,
                        referredUser: user._id,
                        stripeInvoiceId: p.stripeInvoiceId,
                        stripeSubscriptionId: p.stripeSubscriptionId || null,
                        plan,
                        grossAmountUSD: p.amountUSD,
                        commissionPercent: rate * 100,
                        commissionAmountUSD,
                        periodStart: paidAt,
                        status: 'available',
                        createdAt: paidAt, // ← KEY: backdated al mes real del pago
                        updatedAt: paidAt
                    });
                    stats.created += 1;
                } catch (err) {
                    if (err.code !== 11000) console.error('reassign create commission:', err.message);
                }
            }
        }

        // Paso 4: recomputar referralStats de afiliada vieja y nueva
        if (oldReferrerId) await recomputeAffiliateStats(oldReferrerId);
        if (newReferrer)    await recomputeAffiliateStats(newReferrer._id);

        res.json({
            ok: true,
            stats,
            user: {
                _id: user._id,
                username: user.username,
                email: user.email,
                referredBy: user.referredBy
            },
            newReferrer: newReferrer ? {
                _id: newReferrer._id,
                username: newReferrer.username,
                email: newReferrer.email
            } : null
        });
    } catch (err) {
        console.error('reassignReferrer', err);
        res.status(500).json({ message: 'Error al reasignar referidora' });
    }
};

// GET /admin/users/:userId/referrer  — info actual para mostrar en el modal
const getUserReferrerInfo = async (req, res) => {
    try {
        const { userId } = req.params;
        const user = await User.findById(userId)
            .select('username email referredBy')
            .populate('referredBy', 'username email avatar partnerLevel')
            .lean();
        if (!user) return res.status(404).json({ message: 'Usuaria no encontrada' });

        const payments = await Payment.find({
            email: (user.email || '').toLowerCase().trim(),
            status: 'paid',
            amountUSD: { $gt: 0 },
            stripeInvoiceId: { $not: /^trial_/ }
        }).sort({ paidAt: -1 }).select('stripeInvoiceId plan amountUSD paidAt').lean();

        const commissions = await Commission.find({ referredUser: userId })
            .populate('affiliate', 'username email')
            .sort({ createdAt: -1 })
            .lean();

        res.json({
            user: {
                _id: user._id,
                username: user.username,
                email: user.email,
                referredBy: user.referredBy
            },
            payments,
            commissions: commissions.map(c => ({
                _id: c._id,
                affiliate: c.affiliate,
                stripeInvoiceId: c.stripeInvoiceId,
                plan: c.plan,
                amountUSD: c.commissionAmountUSD,
                grossUSD: c.grossAmountUSD,
                status: c.status,
                createdAt: c.createdAt
            }))
        });
    } catch (err) {
        console.error('getUserReferrerInfo', err);
        res.status(500).json({ message: 'Error al obtener info' });
    }
};

module.exports = { reassignReferrer, getUserReferrerInfo };
