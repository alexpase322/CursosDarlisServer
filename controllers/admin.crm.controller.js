const User = require('../models/User');
const Commission = require('../models/Commission');
const PartnerApplication = require('../models/PartnerApplication');
const { setLevelManually } = require('../services/levelService');

// GET /admin/affiliates  — listado paginado con filtros
const listAffiliates = async (req, res) => {
    try {
        const { level, q, sort = '-referralStats.pendingUSD', page = 1, limit = 20 } = req.query;
        const filter = { partnerLevel: { $gte: 2 } };
        if (level) filter.partnerLevel = parseInt(level);
        if (q) {
            filter.$or = [
                { username: { $regex: q, $options: 'i' } },
                { email: { $regex: q, $options: 'i' } }
            ];
        }
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [items, total] = await Promise.all([
            User.find(filter)
                .select('username email avatar partnerLevel partnerLevelSetManually partnerActivatedAt referralStats createdAt')
                .sort(sort)
                .skip(skip)
                .limit(parseInt(limit)),
            User.countDocuments(filter)
        ]);
        res.json({ items, total, page: parseInt(page), limit: parseInt(limit) });
    } catch (err) {
        console.error('listAffiliates', err);
        res.status(500).json({ message: 'Error al listar afiliadas' });
    }
};

// GET /admin/affiliates/:id  — detalle
const getAffiliateDetail = async (req, res) => {
    try {
        const user = await User.findById(req.params.id)
            .select('username email avatar partnerLevel partnerLevelSetManually partnerActivatedAt referralStats subscription createdAt');
        if (!user) return res.status(404).json({ message: 'No encontrada' });

        const [referrals, commissions] = await Promise.all([
            User.find({ referredBy: user._id })
                .select('username avatar email subscription createdAt')
                .sort({ createdAt: -1 }),
            Commission.find({ affiliate: user._id })
                .sort({ createdAt: -1 })
                .limit(100)
                .populate('referredUser', 'username avatar email')
        ]);

        res.json({ user, referrals, commissions });
    } catch (err) {
        console.error('getAffiliateDetail', err);
        res.status(500).json({ message: 'Error al obtener detalle' });
    }
};

// PUT /admin/affiliates/:id/level
const changeLevel = async (req, res) => {
    try {
        const { level } = req.body;
        const newLevel = parseInt(level);
        const user = await setLevelManually(req.params.id, newLevel);
        res.json({ message: 'Nivel actualizado', user });
    } catch (err) {
        console.error('changeLevel', err);
        res.status(400).json({ message: err.message || 'Error al cambiar nivel' });
    }
};

// GET /admin/commissions  — listado global con filtros
const listCommissions = async (req, res) => {
    try {
        const { status, affiliate, from, to, page = 1, limit = 30 } = req.query;
        const filter = {};
        if (status) filter.status = status;
        if (affiliate) filter.affiliate = affiliate;
        if (from || to) {
            filter.createdAt = {};
            if (from) filter.createdAt.$gte = new Date(from);
            if (to) filter.createdAt.$lte = new Date(to);
        }
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [items, total, totals] = await Promise.all([
            Commission.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .populate('affiliate', 'username email avatar partnerLevel')
                .populate('referredUser', 'username email avatar'),
            Commission.countDocuments(filter),
            Commission.aggregate([
                { $match: filter.affiliate ? { ...filter, affiliate: new (require('mongoose').Types.ObjectId)(filter.affiliate) } : filter },
                {
                    $group: {
                        _id: '$status',
                        sum: { $sum: '$commissionAmountUSD' },
                        count: { $sum: 1 }
                    }
                }
            ])
        ]);
        res.json({ items, total, page: parseInt(page), limit: parseInt(limit), totals });
    } catch (err) {
        console.error('listCommissions', err);
        res.status(500).json({ message: 'Error al listar comisiones' });
    }
};

// POST /admin/commissions/:id/mark-paid
const markCommissionPaid = async (req, res) => {
    try {
        const commission = await Commission.findById(req.params.id);
        if (!commission) return res.status(404).json({ message: 'Comisión no encontrada' });
        if (commission.status === 'paid') return res.status(400).json({ message: 'Ya está pagada' });
        if (commission.status === 'voided') return res.status(400).json({ message: 'Está anulada' });

        commission.status = 'paid';
        commission.paidAt = new Date();
        commission.paidNote = req.body.note || '';
        await commission.save();

        const affiliate = await User.findById(commission.affiliate);
        if (affiliate) {
            affiliate.referralStats.pendingUSD = Math.max(0, (affiliate.referralStats.pendingUSD || 0) - commission.commissionAmountUSD);
            affiliate.referralStats.paidUSD = (affiliate.referralStats.paidUSD || 0) + commission.commissionAmountUSD;
            await affiliate.save();
        }

        res.json({ message: 'Comisión marcada como pagada', commission });
    } catch (err) {
        console.error('markCommissionPaid', err);
        res.status(500).json({ message: 'Error al marcar como pagada' });
    }
};

// POST /admin/commissions/bulk-mark-paid
const bulkMarkCommissionsPaid = async (req, res) => {
    try {
        const { ids = [], note = '' } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: 'No hay comisiones seleccionadas' });
        }

        const commissions = await Commission.find({ _id: { $in: ids }, status: { $in: ['available', 'pending'] } });
        const now = new Date();
        const totalsByAffiliate = {};

        for (const c of commissions) {
            c.status = 'paid';
            c.paidAt = now;
            c.paidNote = note;
            await c.save();
            const key = String(c.affiliate);
            totalsByAffiliate[key] = (totalsByAffiliate[key] || 0) + c.commissionAmountUSD;
        }

        for (const [affiliateId, amount] of Object.entries(totalsByAffiliate)) {
            const u = await User.findById(affiliateId);
            if (!u) continue;
            u.referralStats.pendingUSD = Math.max(0, (u.referralStats.pendingUSD || 0) - amount);
            u.referralStats.paidUSD = (u.referralStats.paidUSD || 0) + amount;
            await u.save();
        }

        res.json({ message: `${commissions.length} comisiones marcadas como pagadas`, count: commissions.length });
    } catch (err) {
        console.error('bulkMarkCommissionsPaid', err);
        res.status(500).json({ message: 'Error al marcar pagadas en lote' });
    }
};

// GET /admin/partner-applications
const listApplications = async (req, res) => {
    try {
        const { status = 'pending' } = req.query;
        const filter = {};
        if (status && status !== 'all') filter.status = status;
        const items = await PartnerApplication.find(filter)
            .sort({ createdAt: -1 })
            .populate('user', 'username email avatar partnerLevel subscription createdAt')
            .populate('decidedBy', 'username');
        res.json(items);
    } catch (err) {
        console.error('listApplications', err);
        res.status(500).json({ message: 'Error al listar solicitudes' });
    }
};

// POST /admin/partner-applications/:id/approve
const approveApplication = async (req, res) => {
    try {
        const application = await PartnerApplication.findById(req.params.id);
        if (!application) return res.status(404).json({ message: 'Solicitud no encontrada' });
        if (application.status !== 'pending') {
            return res.status(400).json({ message: 'Solicitud ya decidida' });
        }

        const user = await User.findById(application.user);
        if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

        if (user.partnerLevel < 2) {
            user.partnerLevel = 2;
            user.partnerActivatedAt = user.partnerActivatedAt || new Date();
            await user.save();
        }

        application.status = 'approved';
        application.decidedBy = req.user._id;
        application.decidedAt = new Date();
        await application.save();

        res.json({ message: 'Solicitud aprobada', application, user });
    } catch (err) {
        console.error('approveApplication', err);
        res.status(500).json({ message: 'Error al aprobar' });
    }
};

// POST /admin/partner-applications/:id/reject
const rejectApplication = async (req, res) => {
    try {
        const application = await PartnerApplication.findById(req.params.id);
        if (!application) return res.status(404).json({ message: 'Solicitud no encontrada' });
        if (application.status !== 'pending') {
            return res.status(400).json({ message: 'Solicitud ya decidida' });
        }
        application.status = 'rejected';
        application.decidedBy = req.user._id;
        application.decidedAt = new Date();
        application.rejectionReason = req.body.reason || '';
        await application.save();
        res.json({ message: 'Solicitud rechazada', application });
    } catch (err) {
        console.error('rejectApplication', err);
        res.status(500).json({ message: 'Error al rechazar' });
    }
};

module.exports = {
    listAffiliates,
    getAffiliateDetail,
    changeLevel,
    listCommissions,
    markCommissionPaid,
    bulkMarkCommissionsPaid,
    listApplications,
    approveApplication,
    rejectApplication
};
