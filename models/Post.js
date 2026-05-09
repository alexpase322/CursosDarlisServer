const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
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

module.exports = mongoose.model('Post', postSchema);