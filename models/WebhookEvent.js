const mongoose = require('mongoose');

// Registro de eventos de Stripe ya procesados.
// Sirve para IDEMPOTENCIA: si Stripe reintenta un evento (porque no recibió el
// 200 a tiempo, o por su política de reintentos), lo detectamos y lo saltamos
// en vez de volver a enviar emails/notificaciones y duplicar efectos.
const webhookEventSchema = new mongoose.Schema({
    eventId: { type: String, required: true, unique: true, index: true },
    type: { type: String },
    processedAt: { type: Date, default: Date.now }
});

// Se autolimpian a los 7 días (Stripe deja de reintentar mucho antes).
webhookEventSchema.index({ processedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = mongoose.model('WebhookEvent', webhookEventSchema);
