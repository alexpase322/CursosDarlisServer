const mongoose = require('mongoose');

const attemptAnswerSchema = new mongoose.Schema({
    questionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    selectedOptionIds: [{ type: mongoose.Schema.Types.ObjectId }],
    isCorrect: { type: Boolean, default: false }
}, { _id: false });

const quizAttemptSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    quiz: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    answers: [attemptAnswerSchema],
    correctCount: { type: Number, default: 0 },
    totalQuestions: { type: Number, default: 0 },
    scorePercent: { type: Number, default: 0 },
    passed: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('QuizAttempt', quizAttemptSchema);
