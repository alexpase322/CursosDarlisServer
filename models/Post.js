const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
    // Tablero al que pertenece. Los tres comparten comentarios, reacciones y
    // moderación; solo cambia quién puede publicar y cómo se presenta.
    //   muro     → cualquiera publica
    //   tareas   → cualquiera publica, admite adjuntar archivo
    //   anuncios → SOLO admin publica; el resto ve y comenta
    board: {
        type: String,
        enum: ['muro', 'tareas', 'anuncios'],
        default: 'muro',
        index: true
    },
    // Archivo adjunto para las entregas de tareas (PDF, documento, zip).
    // La imagen sigue en `image` porque se muestra distinto.
    attachment: {
        url: { type: String },
        name: { type: String },
        mime: { type: String },
        size: { type: Number }
    },
    author: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true 
    },
    content: { type: String, required: true },
    image: { type: String }, // Foto opcional en el post
    likes: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
        // Al guardar likes aquí, podemos verificar si el ID ya existe para no dar like 2 veces
    }],
    reactions: [{
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        type: { type: String, enum: ['heart', 'fire', 'muscle', 'clap', 'sparkles'], required: true },
        createdAt: { type: Date, default: Date.now }
    }],
    comments: [{
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        text: { type: String, required: true },
        createdAt: { type: Date, default: Date.now }
    }]
}, { timestamps: true });

// Todos los listados consultan por tablero y ordenan por fecha.
postSchema.index({ board: 1, createdAt: -1 });

module.exports = mongoose.model('Post', postSchema);