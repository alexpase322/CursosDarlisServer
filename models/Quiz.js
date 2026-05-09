const mongoose = require('mongoose');

const optionSchema = new mongoose.Schema({
    text: { type: String, required: true },
    isCorrect: { type: Boolean, default: false }
}, { _id: true });

const questionSchema = new mongoose.Schema({
    text: { type: String, required: true },
    options: {
        type: [optionSchema],
        validate: [arr => arr.length >= 2 && arr.length <= 6, 'Cada pregunta debe tener entre 2 y 6 opciones']
    },
    explanation: { type: String, default: '' }
}, { _id: true });

const quizSchema = new mongoose.Schema({
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, unique: true, index: true },
    title: { type: String, default: 'Examen final del curso' },
    description: { type: String, default: '' },
    passingScore: { type: Number, default: 70, min: 0, max: 100 }, // % para aprobar
    questions: {
        type: [questionSchema],
        validate: [arr => arr.length <= 10, 'Máximo 10 preguntas']
    },
    isActive: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Quiz', quizSchema);
