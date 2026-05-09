const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { getMyEngagement } = require('../controllers/engagement.controller');

router.get('/me', protect, getMyEngagement);

module.exports = router;
