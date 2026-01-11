const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    text: { type: String, required: true },
}, { timestamps: true });

const conversationSchema = new mongoose.Schema({
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // Array de usuarios en el chat (permite grupos)
    isGroup: { type: Boolean, default: false },
    groupName: { type: String }, // Solo si isGroup es true
    messages: [messageSchema], // Historial de mensajes
    lastMessage: { type: String }, // Para mostrar en la vista previa
}, { timestamps: true });

module.exports = mongoose.model('Conversation', conversationSchema);