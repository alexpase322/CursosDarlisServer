const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { 
    createConversation, 
    getConversations, 
    sendMessage,
    searchUsers,
    deleteConversation 
} = require('../controllers/chat.controller');

router.post('/', protect, createConversation); // Crear chat
router.get('/', protect, getConversations);    // Obtener mis chats
router.post('/message', protect, sendMessage); // Guardar mensaje
router.get('/users', protect, searchUsers);    // Buscar gente para chatear
router.delete('/:id', protect, deleteConversation); // <--- NUEVA RUTA

module.exports = router;