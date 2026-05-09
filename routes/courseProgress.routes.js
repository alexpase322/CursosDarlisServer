const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
    markLessonComplete,
    unmarkLessonComplete,
    getMyCourseProgress,
    getAllMyProgress
} = require('../controllers/courseProgress.controller');

router.use(protect);

router.get('/progress/me', getAllMyProgress);
router.get('/:courseId/progress', getMyCourseProgress);
router.post('/:courseId/lessons/:lessonId/complete', markLessonComplete);
router.delete('/:courseId/lessons/:lessonId/complete', unmarkLessonComplete);

module.exports = router;
