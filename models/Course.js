const mongoose = require('mongoose');

// Esquema de la Clase (Lección individual)
const lessonSchema = new mongoose.Schema({
    title: { type: String, required: true },
    videoUrl: { type: String, required: true }, // URL del video (Youtube/Vimeo/AWS)
    description: { type: String },
    completedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // Para trackear progreso
    order: { type: Number, default: 0 },

  // Nuevo: Array de recursos
    resources: [{
        label: { type: String, required: true }, // Ej: "Diapositivas"
        url: { type: String, required: true },   // Ej: "https://drive..."
        type: { type: String, default: 'file' }  // Ej: 'pdf', 'link'
    }]
});

// Esquema del Módulo (Conjunto de clases)
const moduleSchema = new mongoose.Schema({
    title: { type: String, required: true },
    order: { type: Number, default: 0 },
    lessons: [lessonSchema] // Array de lecciones incrustadas
});

// Esquema del Curso Principal
const courseSchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: { type: String, required: true },
    thumbnail: { type: String }, // Imagen de portada del curso
    instructor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    modules: [moduleSchema], // Array de módulos incrustados
    students: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] // Usuarios inscritos
}, { timestamps: true });

module.exports = mongoose.model('Course', courseSchema);