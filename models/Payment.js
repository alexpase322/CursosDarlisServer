const mongoose = require('mongoose');

// Registro de cada pago exitoso recibido de Stripe.
// Se usa como "ticket" para validar que un email tiene derecho a ser invitado a la plataforma.
const paymentSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        index: true,
        lowercase: true,
        trim: true
    },
    stripeCustomerId: { type: String, index: true },
    stripeInvoiceId: { type: String, unique: true, sparse: true },
    stripeSessionId: { type: String, index: true, sparse: true },
    stripeSubscriptionId: { type: String, index: true, sparse: true },
    plan: {
        type: String,
        enum: ['monthly', 'quarterly', 'yearly'],
        default: 'monthly'
    },
    amountUSD: { type: Number, default: 0 },
    status: {
        type: String,
        enum: ['paid', 'refunded', 'failed'],
        default: 'paid'
    },
    paidAt: { type: Date, default: Date.now },
    refundedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    attemptCount: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    consumedByInviteAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);
