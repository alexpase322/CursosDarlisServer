const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // Quién recibe
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Quién provocó la acción
    type: { type: String, enum: ['like', 'comment', 'system', 'invite'], required: true },
    content: { type: String, required: true }, // "A Juan le gustó tu foto"
    link: { type: String }, // "/muro", "/course/123"
    isRead: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Notification', notificationSchema);