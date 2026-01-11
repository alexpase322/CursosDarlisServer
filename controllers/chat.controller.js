const Conversation = require('../models/Chat');
const User = require('../models/User');

// 1. Crear conversación (o devolver la existente si es 1 a 1)
const createConversation = async (req, res) => {
    const { receiverId } = req.body; // El ID de la persona con la que quiero hablar

    try {
        // Buscamos si ya existe un chat PRIVADO entre estos dos
        const existingChat = await Conversation.findOne({
            isGroup: false,
            members: { $all: [req.user._id, receiverId] }
        }).populate('members', 'username avatar email');

        if (existingChat) {
            return res.json(existingChat);
        }

        // Si no existe, creamos uno nuevo
        const newConversation = new Conversation({
            members: [req.user._id, receiverId],
            isGroup: false
        });

        const savedConversation = await newConversation.save();
        const populatedConversation = await savedConversation.populate('members', 'username avatar');
        
        res.status(201).json(populatedConversation);
    } catch (error) {
        res.status(500).json(error);
    }
};

// 2. Obtener mis conversaciones (Sidebar)
const getConversations = async (req, res) => {
    try {
        const conversations = await Conversation.find({
            members: { $in: [req.user._id] }
        })
        .populate('members', 'username avatar')
        .sort({ updatedAt: -1 }); // Los chats más recientes arriba

        res.json(conversations);
    } catch (error) {
        res.status(500).json(error);
    }
};

// 3. Enviar Mensaje (Guardar en BD)
const sendMessage = async (req, res) => {
    const { conversationId, text } = req.body;

    try {
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) return res.status(404).json({ message: "Chat no encontrado" });

        const newMessage = {
            sender: req.user._id,
            text: text,
            createdAt: new Date()
        };

        // Agregamos el mensaje al array y actualizamos lastMessage
        conversation.messages.push(newMessage);
        conversation.lastMessage = text;
        
        await conversation.save();

        // Devolvemos el mensaje enriquecido con datos del sender (opcional)
        // Pero para rapidez devolvemos el objeto simple, el front ya sabe quién soy
        res.status(200).json(newMessage);

    } catch (error) {
        res.status(500).json(error);
    }
};

// 4. Obtener usuarios para iniciar chat (Buscador simple)
const searchUsers = async (req, res) => {
    try {
        // Busca usuarios que NO sean yo
        const users = await User.find({ _id: { $ne: req.user._id } }).select('username avatar email');
        res.json(users);
    } catch (error) {
        res.status(500).json(error);
    }
};

const deleteConversation = async (req, res) => {
    try {
        const conversation = await Conversation.findById(req.params.id);
        
        if (!conversation) {
            return res.status(404).json({ message: "Conversación no encontrada" });
        }

        // Seguridad: Verificar que quien borra pertenece al chat
        if (!conversation.members.includes(req.user._id)) {
            return res.status(403).json({ message: "No tienes permiso para eliminar este chat" });
        }

        await conversation.deleteOne();
        res.status(200).json({ message: "Conversación eliminada" });

    } catch (error) {
        res.status(500).json(error);
    }
};

module.exports = { createConversation, getConversations, sendMessage, searchUsers, deleteConversation };