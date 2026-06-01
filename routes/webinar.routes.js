const express = require('express');
const router = express.Router();
const { protect, admin } = require('../middleware/authMiddleware');
const { registerLead, markWatched, listLeads } = require('../controllers/webinar.controller');

// Públicas
router.post('/register', registerLead);
router.post('/mark-watched/:id', markWatched);

// Admin
router.get('/admin/leads', protect, admin, listLeads);

module.exports = router;
