const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { getAffiliatesLeaderboard } = require('../controllers/leaderboard.controller');

router.get('/affiliates', protect, getAffiliatesLeaderboard);

module.exports = router;
