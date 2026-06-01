const mongoose = require('mongoose');

// Registro de personas interesadas que vieron el webinar gratuito.
// Lo usamos para enviarles seguimiento por email y medir conversión.
const webinarLeadSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    phone: { type: String, trim: true, default: '' },
    source: { type: String, default: 'webinar-page' }, // de dónde llegó (utm, página, etc.)
    watchedFull: { type: Boolean, default: false },    // si terminó el video (lo seteamos vía evento)
    converted: { type: Boolean, default: false },      // si después se suscribió
    notes: { type: String, default: '' },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' }
}, { timestamps: true });

webinarLeadSchema.index({ email: 1, createdAt: -1 });

module.exports = mongoose.model('WebinarLead', webinarLeadSchema);
