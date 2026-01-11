const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { getNotifications, markAsRead } = require('../controllers/notification.controller');

router.get('/', protect, getNotifications);
router.put('/:id/read', protect, markAsRead); // Marcar una específica
router.put('/read-all', protect, markAsRead); // Marcar todas

module.exports = router;