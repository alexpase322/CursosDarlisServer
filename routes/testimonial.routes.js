const express = require('express');
const router = express.Router();
const { protect, admin } = require('../middleware/authMiddleware');
const { singleImage } = require('../config/upload');
const {
    getTestimonials,
    getMyTestimonials,
    createTestimonial,
    deleteTestimonial,
    getFeaturedTestimonials,
    adminListTestimonials,
    toggleFeatured,
    setStatus
} = require('../controllers/testimonial.controller');

// Público (landing)
router.get('/public/featured', getFeaturedTestimonials);

// Admin
router.get('/admin/all', protect, admin, adminListTestimonials);
router.patch('/:id/feature', protect, admin, toggleFeatured);
router.patch('/:id/status', protect, admin, setStatus);

// Miembros
router.get('/', protect, getTestimonials);
router.get('/me', protect, getMyTestimonials);
router.post('/', protect, singleImage('image'), createTestimonial);
router.delete('/:id', protect, deleteTestimonial);

module.exports = router;
