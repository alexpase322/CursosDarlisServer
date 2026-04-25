const mongoose = require('mongoose');

const partnerApplicationSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    },
    message: { type: String, default: '' },
    decidedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    decidedAt: { type: Date },
    rejectionReason: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('PartnerApplication', partnerApplicationSchema);
