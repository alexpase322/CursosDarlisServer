const User = require('../models/User');
const Commission = require('../models/Commission');
const PartnerApplication = require('../models/PartnerApplication');
const Payment = require('../models/Payment');
const { rates, prices } = require('../config/affiliateConfig');

// GET /affiliate/me  — resumen de la afiliada autenticada
const getMyAffiliateSummary = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select(
            'username avatar partnerLevel partnerLevelSetManually partnerActivatedAt referralStats'
        );
        if (!user) return res.status(404).json({ message: 'No encontrado' });

        const application = await PartnerApplication.findOne({ user: user._id }).sort({ createdAt: -1 });

        // ---- Stats agregadas LIVE (no dependemos de referralStats almacenado, que
        // puede quedar desfasado si una referida completa perfil sin disparar el contador).
        const [totalReferred, activeReferred, statusAgg] = await Promise.all([
            User.countDocuments({ referredBy: user._id }),
            User.countDocuments({
                referredBy: user._id,
                'subscription.status': { $in: ['active', 'trialing', 'past_due'] }
            }),
            Commission.aggregate([
                { $match: { affiliate: user._id } },
                { $group: { _id: '$status', total: { $sum: '$commissionAmountUSD' } } }
            ])
        ]);
        const byStatus = { available: 0, pending: 0, paid: 0, voided: 0 };
        for (const s of statusAgg) byStatus[s._id] = s.total;
        const liveStats = {
            totalReferred,
            activeReferred,
            totalEarnedUSD: +(byStatus.available + byStatus.pending + byStatus.paid).toFixed(2),
            pendingUSD: +(byStatus.available + byStatus.pending).toFixed(2),
            paidUSD: +byStatus.paid.toFixed(2)
        };

        // ---- Métricas del mes en curso ----
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

        // 1) Ganado este mes: comisiones ya generadas dentro del mes (no anuladas).
        const earnedAgg = await Commission.aggregate([
            { $match: {
                affiliate: user._id,
                status: { $ne: 'voided' },
                createdAt: { $gte: monthStart, $lt: monthEnd }
            }},
            { $group: { _id: null, total: { $sum: '$commissionAmountUSD' } } }
        ]);
        const earnedThisMonth = earnedAgg[0]?.total || 0;

        // 2) Por cobrar este mes: referidas cuyo próximo cobro (currentPeriodEnd)
        //    cae dentro del mes actual. Cubre mensual / trimestral / anual de forma
        //    uniforme — si la trimestral renueva en este mes, suma $48; si la anual
        //    renueva en este mes, suma $198.50; si solo es mensual, suma $20.
        const upcomingReferrals = await User.find({
            referredBy: user._id,
            'subscription.status': { $in: ['active', 'trialing', 'past_due'] },
            'subscription.currentPeriodEnd': { $gte: now, $lt: monthEnd }
        }).select('subscription').lean();

        let projectedThisMonth = 0;
        const projectionBreakdown = { monthly: 0, quarterly: 0, yearly: 0 };
        for (const r of upcomingReferrals) {
            const plan = r.subscription?.plan;
            const rate = rates[plan];
            const price = prices[plan];
            if (rate && price) {
                const amt = rate * price;
                projectedThisMonth += amt;
                projectionBreakdown[plan] = (projectionBreakdown[plan] || 0) + amt;
            }
        }

        res.json({
            _id: user._id,
            username: user.username,
            avatar: user.avatar,
            partnerLevel: user.partnerLevel,
            partnerActivatedAt: user.partnerActivatedAt,
            stats: liveStats,
            monthly: {
                earnedThisMonth: Number(earnedThisMonth.toFixed(2)),
                projectedThisMonth: Number(projectedThisMonth.toFixed(2)),
                estimatedTotalThisMonth: Number((earnedThisMonth + projectedThisMonth).toFixed(2)),
                projectionBreakdown
            },
            application: application
                ? { status: application.status, createdAt: application.createdAt, rejectionReason: application.rejectionReason }
                : null
        });
    } catch (err) {
        console.error('getMyAffiliateSummary', err);
        res.status(500).json({ message: 'Error al obtener resumen' });
    }
};

// GET /affiliate/me/commissions
const getMyCommissions = async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const filter = { affiliate: req.user._id };
        if (status) filter.status = status;

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [items, total] = await Promise.all([
            Commission.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .populate('referredUser', 'username avatar email'),
            Commission.countDocuments(filter)
        ]);

        res.json({ items, total, page: parseInt(page), limit: parseInt(limit) });
    } catch (err) {
        console.error('getMyCommissions', err);
        res.status(500).json({ message: 'Error al obtener comisiones' });
    }
};

// GET /affiliate/me/referrals
const getMyReferrals = async (req, res) => {
    try {
        const referrals = await User.find({ referredBy: req.user._id })
            .select('username avatar email subscription createdAt')
            .sort({ createdAt: -1 });
        res.json(referrals);
    } catch (err) {
        console.error('getMyReferrals', err);
        res.status(500).json({ message: 'Error al obtener referidas' });
    }
};

// POST /affiliate/apply  — solicitar pasar de N1 a N2
const applyForPartner = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) return res.status(404).json({ message: 'No encontrado' });
        if (user.partnerLevel >= 2) {
            return res.status(400).json({ message: 'Ya eres Partner' });
        }

        // Elegibilidad: suscripción activa/trialing en Stripe, o al menos un Payment 'paid'
        // registrado para este email (cubre pagos one-shot y trials sincronizados).
        const subOk = user.subscription && ['active', 'trialing', 'past_due'].includes(user.subscription.status);
        const hasPaid = await Payment.exists({ email: (user.email || '').toLowerCase().trim(), status: 'paid' });
        if (!subOk && !hasPaid) {
            return res.status(400).json({ message: 'Necesitas tener una membresía activa para aplicar' });
        }

        const existing = await PartnerApplication.findOne({ user: user._id });
        if (existing && existing.status === 'pending') {
            return res.status(400).json({ message: 'Ya tienes una solicitud pendiente' });
        }

        let application;
        if (existing) {
            existing.status = 'pending';
            existing.message = req.body.message || '';
            existing.decidedBy = undefined;
            existing.decidedAt = undefined;
            existing.rejectionReason = '';
            application = await existing.save();
        } else {
            application = await PartnerApplication.create({
                user: user._id,
                message: req.body.message || ''
            });
        }

        res.status(201).json(application);
    } catch (err) {
        console.error('applyForPartner', err);
        res.status(500).json({ message: 'Error al enviar la solicitud' });
    }
};

module.exports = {
    getMyAffiliateSummary,
    getMyCommissions,
    getMyReferrals,
    applyForPartner
};
