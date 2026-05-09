const Quiz = require('../models/Quiz');
const QuizAttempt = require('../models/QuizAttempt');
const Course = require('../models/Course');

// ====== ALUMNA ======

// GET /quizzes/course/:courseId  → quiz "limpio" sin marcar respuestas correctas
const getQuizForStudent = async (req, res) => {
    try {
        const { courseId } = req.params;
        const quiz = await Quiz.findOne({ course: courseId, isActive: true }).lean();
        if (!quiz) return res.status(404).json({ message: 'Este curso no tiene quiz' });
        const safe = {
            _id: quiz._id,
            course: quiz.course,
            title: quiz.title,
            description: quiz.description,
            passingScore: quiz.passingScore,
            questions: quiz.questions.map(q => ({
                _id: q._id,
                text: q.text,
                options: q.options.map(o => ({ _id: o._id, text: o.text }))
            }))
        };
        const attempts = await QuizAttempt.find({ user: req.user._id, quiz: quiz._id })
            .sort({ createdAt: -1 }).limit(5).lean();
        res.json({ quiz: safe, attempts: attempts.map(a => ({
            _id: a._id, scorePercent: a.scorePercent, correctCount: a.correctCount,
            totalQuestions: a.totalQuestions, passed: a.passed, createdAt: a.createdAt
        })) });
    } catch (err) {
        console.error('getQuizForStudent', err);
        res.status(500).json({ message: 'Error al obtener quiz' });
    }
};

// POST /quizzes/:quizId/attempts  body: { answers: [{ questionId, selectedOptionIds:[ids] }] }
const submitAttempt = async (req, res) => {
    try {
        const { quizId } = req.params;
        const { answers = [] } = req.body || {};
        const quiz = await Quiz.findById(quizId).lean();
        if (!quiz || !quiz.isActive) return res.status(404).json({ message: 'Quiz no disponible' });

        let correctCount = 0;
        const evaluated = quiz.questions.map(q => {
            const userAns = answers.find(a => String(a.questionId) === String(q._id));
            const userSelected = new Set((userAns?.selectedOptionIds || []).map(String));
            const correctIds = new Set(q.options.filter(o => o.isCorrect).map(o => String(o._id)));
            // Correcta si los conjuntos coinciden exactamente
            const isCorrect = userSelected.size === correctIds.size &&
                [...correctIds].every(id => userSelected.has(id));
            if (isCorrect) correctCount += 1;
            return {
                questionId: q._id,
                selectedOptionIds: [...userSelected],
                isCorrect
            };
        });

        const totalQuestions = quiz.questions.length;
        const scorePercent = totalQuestions === 0 ? 0 : Math.round((correctCount / totalQuestions) * 100);
        const passed = scorePercent >= (quiz.passingScore || 70);

        const attempt = await QuizAttempt.create({
            user: req.user._id,
            quiz: quiz._id,
            course: quiz.course,
            answers: evaluated,
            correctCount,
            totalQuestions,
            scorePercent,
            passed
        });

        // Devolvemos respuestas correctas para feedback inmediato.
        const reveal = quiz.questions.map(q => ({
            questionId: q._id,
            correctOptionIds: q.options.filter(o => o.isCorrect).map(o => o._id),
            explanation: q.explanation || ''
        }));

        res.json({
            attempt: {
                _id: attempt._id,
                correctCount, totalQuestions, scorePercent, passed,
                passingScore: quiz.passingScore
            },
            reveal
        });
    } catch (err) {
        console.error('submitAttempt', err);
        res.status(500).json({ message: 'Error al enviar quiz' });
    }
};

// ====== ADMIN ======

// GET /quizzes/admin/course/:courseId  → trae quiz completo (incluye correctas)
const getQuizAdmin = async (req, res) => {
    try {
        const { courseId } = req.params;
        const quiz = await Quiz.findOne({ course: courseId });
        res.json({ quiz: quiz || null });
    } catch (err) {
        console.error('getQuizAdmin', err);
        res.status(500).json({ message: 'Error al obtener quiz' });
    }
};

// PUT /quizzes/admin/course/:courseId  body: { title, description, passingScore, questions, isActive }
const upsertQuizAdmin = async (req, res) => {
    try {
        const { courseId } = req.params;
        const course = await Course.findById(courseId);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        const payload = {
            course: courseId,
            title: req.body.title || 'Examen final del curso',
            description: req.body.description || '',
            passingScore: Number.isFinite(+req.body.passingScore) ? +req.body.passingScore : 70,
            questions: Array.isArray(req.body.questions) ? req.body.questions.slice(0, 10) : [],
            isActive: req.body.isActive !== false
        };

        // Validar al menos 1 pregunta y que cada una tenga al menos 1 correcta.
        for (const [i, q] of payload.questions.entries()) {
            if (!q.text || !Array.isArray(q.options) || q.options.length < 2) {
                return res.status(400).json({ message: `Pregunta ${i + 1} inválida (mínimo 2 opciones).` });
            }
            if (!q.options.some(o => o.isCorrect)) {
                return res.status(400).json({ message: `Pregunta ${i + 1} debe tener al menos una opción correcta.` });
            }
        }

        const quiz = await Quiz.findOneAndUpdate(
            { course: courseId },
            payload,
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        res.json({ quiz });
    } catch (err) {
        console.error('upsertQuizAdmin', err);
        res.status(500).json({ message: err.message || 'Error al guardar quiz' });
    }
};

// DELETE /quizzes/admin/course/:courseId
const deleteQuizAdmin = async (req, res) => {
    try {
        await Quiz.deleteOne({ course: req.params.courseId });
        res.json({ ok: true });
    } catch (err) {
        console.error('deleteQuizAdmin', err);
        res.status(500).json({ message: 'Error al borrar quiz' });
    }
};

module.exports = { getQuizForStudent, submitAttempt, getQuizAdmin, upsertQuizAdmin, deleteQuizAdmin };
