const express = require('express');
const router = express.Router();
const { protect, admin } = require('../middleware/authMiddleware');
const {
    listAffiliates,
    getAffiliateDetail,
    changeLevel,
    listCommissions,
    markCommissionPaid,
    bulkMarkCommissionsPaid,
    listApplications,
    approveApplication,
    rejectApplication
} = require('../controllers/admin.crm.controller');
const { syncPayments } = require('../controllers/stripe.sync.controller');
const { listSubscriptions, registerManualPayment } = require('../controllers/admin.subscriptions.controller');
const { getMonthlyRevenue } = require('../controllers/admin.revenue.controller');

router.use(protect, admin);

router.get('/affiliates', listAffiliates);
router.get('/affiliates/:id', getAffiliateDetail);
router.put('/affiliates/:id/level', changeLevel);

router.get('/commissions', listCommissions);
router.post('/commissions/bulk-mark-paid', bulkMarkCommissionsPaid);
router.post('/commissions/:id/mark-paid', markCommissionPaid);

router.get('/partner-applications', listApplications);
router.post('/partner-applications/:id/approve', approveApplication);
router.post('/partner-applications/:id/reject', rejectApplication);

router.post('/stripe/sync-payments', syncPayments);

router.get('/subscriptions', listSubscriptions);
router.post('/subscriptions/:userId/manual-payment', registerManualPayment);

router.get('/revenue/monthly', getMonthlyRevenue);

module.exports = router;
