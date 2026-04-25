const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String },
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user'
    },
    avatar: {
        type: String,
        default: 'https://res.cloudinary.com/demo/image/upload/v1578587614/sample.jpg'
    },
    bio: { type: String, default: '' },
    status: {
        type: String,
        enum: ["pending", "active"],
        default: "pending"
    },
    invitationToken: { type: String },
    resetPasswordToken: { type: String },
    resetPasswordExpire: { type: Date },
    subscription: {
        id: String,
        status: String,
        plan: String,
        currentPeriodEnd: Date,
        customerId: String
    },

    // --- Programa de afiliadas ---
    partnerLevel: {
        type: Number,
        enum: [1, 2, 3, 4],
        default: 1
    },
    partnerLevelSetManually: {
        type: Boolean,
        default: false
    },
    referredBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    referralStats: {
        totalReferred: { type: Number, default: 0 },
        activeReferred: { type: Number, default: 0 },
        totalEarnedUSD: { type: Number, default: 0 },
        pendingUSD: { type: Number, default: 0 },
        paidUSD: { type: Number, default: 0 }
    },
    partnerActivatedAt: { type: Date },
    // Entrenamiento comercial requerido para promover de N2 a N3 (sec. 5.2 del doc).
    trainingCompleted: { type: Boolean, default: false },
    trainingCompletedAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
