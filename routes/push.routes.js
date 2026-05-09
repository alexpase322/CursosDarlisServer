const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { getPublicKey, subscribe, unsubscribe } = require('../controllers/push.controller');

router.get('/public-key', getPublicKey);
router.post('/subscribe', protect, subscribe);
router.post('/unsubscribe', protect, unsubscribe);

module.exports = router;
