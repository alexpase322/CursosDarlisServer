const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
    getMyAffiliateSummary,
    getMyCommissions,
    getMyReferrals,
    applyForPartner
} = require('../controllers/affiliate.controller');

// Middleware: solo afiliadas (partnerLevel >= 2) o admin. Para /apply (N1) se omite.
const partnerOnly = (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'No autorizado' });
    if (req.user.role === 'admin') return next();
    if ((req.user.partnerLevel || 1) < 2) {
        return res.status(403).json({ message: 'Acceso reservado a Partners (Nivel 2+)' });
    }
    next();
};

router.get('/me', protect, partnerOnly, getMyAffiliateSummary);
router.get('/me/commissions', protect, partnerOnly, getMyCommissions);
router.get('/me/referrals', protect, partnerOnly, getMyReferrals);
router.post('/apply', protect, applyForPartner);

module.exports = router;
