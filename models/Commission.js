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
        enum: ['monthly', 'quarterly', 'yearly'],
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
    paidAt: { type: Date },
    paidNote: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('Commission', commissionSchema);
