const mongoose = require('mongoose');

// Testimonio de una arquitecta (alumna). Los miembros pueden publicarlos y verlos
// entre sí; el admin puede destacarlos (featured) para mostrarlos en la landing
// pública y ocultar los inapropiados (status: hidden).
const testimonialSchema = new mongoose.Schema({
    author: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    content: {
        type: String,
        required: true,
        trim: true,
        maxlength: 1000
    },
    rating: {
        type: Number,
        min: 1,
        max: 5,
        default: 5
    },
    image: { type: String },        // foto opcional (resultado, captura, etc.)
    // approved: visible para toda la comunidad.  hidden: oculto por el admin.
    status: {
        type: String,
        enum: ['approved', 'hidden'],
        default: 'approved',
        index: true
    },
    featured: { type: Boolean, default: false, index: true } // se muestra en la landing pública
}, { timestamps: true });

module.exports = mongoose.model('Testimonial', testimonialSchema);
