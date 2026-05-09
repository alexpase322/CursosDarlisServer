const express = require('express');
const router = express.Router();
const { protect, admin } = require('../middleware/authMiddleware');
const {
    getQuizForStudent, submitAttempt,
    getQuizAdmin, upsertQuizAdmin, deleteQuizAdmin
} = require('../controllers/quiz.controller');

router.use(protect);

// Alumna
router.get('/course/:courseId', getQuizForStudent);
router.post('/:quizId/attempts', submitAttempt);

// Admin
router.get('/admin/course/:courseId', admin, getQuizAdmin);
router.put('/admin/course/:courseId', admin, upsertQuizAdmin);
router.delete('/admin/course/:courseId', admin, deleteQuizAdmin);

module.exports = router;
