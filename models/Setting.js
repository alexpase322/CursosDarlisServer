const mongoose = require('mongoose');

// Configuraciones globales tipo key-value (promos, flags, etc.)
const settingSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

module.exports = mongoose.model('Setting', settingSchema);
