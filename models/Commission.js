const mongoose = require('mongoose');

const commissionSchema = new mongoose.Schema({
    affiliate: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    referredUser: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    stripeInvoiceId: {
        type: String,
        required: true,
        unique: true
    },
    stripeSubscriptionId: { type: String },
    plan: {
        type: String,
        enum: ['monthly', 'quarterly', 'yearly', 'lifetime'],
        required: true
    },
    grossAmountUSD: { type: Number, required: true },
    commissionPercent: { type: Number, required: true },
    commissionAmountUSD: { type: Number, required: true },
    periodStart: { type: Date },
    periodEnd: { type: Date },
    status: {
        type: String,
        enum: ['pending', 'available', 'paid', 'voided'],
        default: 'available'
    },
    // Quién paga la comisión a la afiliada:
    //   internal → la pagamos nosotros (transferencia manual)
    //   beacons  → la paga Beacons externamente (solo trazabilidad aquí)
    //   stripe   → venta por Stripe checkout (la pagamos nosotros)
    payoutSource: {
        type: String,
        enum: ['internal', 'beacons', 'stripe'],
        default: 'internal'
    },
    paidAt: { type: Date },
    paidNote: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('Commission', commissionSchema);
