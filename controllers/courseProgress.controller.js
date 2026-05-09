const Course = require('../models/Course');
const QuizAttempt = require('../models/QuizAttempt');

// POST /courses/:courseId/lessons/:lessonId/complete
// Marca una lección como completada por el usuario.
const markLessonComplete = async (req, res) => {
    try {
        const { courseId, lessonId } = req.params;
        const userId = req.user._id;

        const course = await Course.findById(courseId);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        let lesson = null;
        for (const m of course.modules) {
            const found = m.lessons.id(lessonId);
            if (found) { lesson = found; break; }
        }
        if (!lesson) return res.status(404).json({ message: 'Lección no encontrada' });

        if (!lesson.completedBy.some(id => id.toString() === userId.toString())) {
            lesson.completedBy.push(userId);
            await course.save();
        }

        res.json({ ok: true });
    } catch (err) {
        console.error('markLessonComplete', err);
        res.status(500).json({ message: 'Error al marcar lección' });
    }
};

// DELETE /courses/:courseId/lessons/:lessonId/complete
const unmarkLessonComplete = async (req, res) => {
    try {
        const { courseId, lessonId } = req.params;
        const userId = req.user._id;
        const course = await Course.findById(courseId);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });
        for (const m of course.modules) {
            const lesson = m.lessons.id(lessonId);
            if (lesson) {
                lesson.completedBy = lesson.completedBy.filter(id => id.toString() !== userId.toString());
                break;
            }
        }
        await course.save();
        res.json({ ok: true });
    } catch (err) {
        console.error('unmarkLessonComplete', err);
        res.status(500).json({ message: 'Error al desmarcar lección' });
    }
};

// GET /courses/:courseId/progress  → { lessonsTotal, lessonsCompleted, percent, completed (bool), quizPassed }
const getMyCourseProgress = async (req, res) => {
    try {
        const { courseId } = req.params;
        const userId = req.user._id;

        const course = await Course.findById(courseId).lean();
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        let lessonsTotal = 0;
        let lessonsCompleted = 0;
        for (const m of course.modules || []) {
            for (const l of m.lessons || []) {
                lessonsTotal += 1;
                if ((l.completedBy || []).some(id => id.toString() === userId.toString())) {
                    lessonsCompleted += 1;
                }
            }
        }
        const percent = lessonsTotal === 0 ? 0 : Math.round((lessonsCompleted / lessonsTotal) * 100);

        // Quiz aprobado del curso (si existe).
        const lastAttempt = await QuizAttempt.findOne({
            user: userId, course: courseId, passed: true
        }).sort({ createdAt: -1 }).lean();
        const quizPassed = !!lastAttempt;

        // Curso completado = quiz aprobado (la barra de lecciones es referencial).
        // Si no hay quiz definido, completado = todas las lecciones marcadas.
        const Quiz = require('../models/Quiz');
        const courseHasQuiz = await Quiz.exists({ course: courseId, isActive: true });
        const completed = courseHasQuiz ? quizPassed : (percent === 100);

        res.json({ lessonsTotal, lessonsCompleted, percent, completed, quizPassed, hasQuiz: !!courseHasQuiz });
    } catch (err) {
        console.error('getMyCourseProgress', err);
        res.status(500).json({ message: 'Error al obtener progreso' });
    }
};

// GET /courses/progress/me  → resumen de progreso para todos los cursos del alumno.
const getAllMyProgress = async (req, res) => {
    try {
        const userId = req.user._id;
        const courses = await Course.find({}).select('title thumbnail modules').lean();
        const Quiz = require('../models/Quiz');

        const items = await Promise.all(courses.map(async (c) => {
            let total = 0, done = 0;
            for (const m of c.modules || []) {
                for (const l of m.lessons || []) {
                    total += 1;
                    if ((l.completedBy || []).some(id => id.toString() === userId.toString())) done += 1;
                }
            }
            const hasQuiz = await Quiz.exists({ course: c._id, isActive: true });
            const passed = hasQuiz ? !!(await QuizAttempt.findOne({ user: userId, course: c._id, passed: true })) : false;
            const percent = total === 0 ? 0 : Math.round((done / total) * 100);
            return {
                courseId: c._id,
                title: c.title,
                thumbnail: c.thumbnail,
                lessonsTotal: total,
                lessonsCompleted: done,
                percent,
                completed: hasQuiz ? passed : (percent === 100),
                hasQuiz: !!hasQuiz,
                quizPassed: passed
            };
        }));

        res.json({ items });
    } catch (err) {
        console.error('getAllMyProgress', err);
        res.status(500).json({ message: 'Error al obtener progreso' });
    }
};

module.exports = { markLessonComplete, unmarkLessonComplete, getMyCourseProgress, getAllMyProgress };
