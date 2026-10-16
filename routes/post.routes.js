const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { singleAttachment } = require('../config/upload');
const {
    getPosts,
    createPost,
    toggleLike,
    addComment,
    deletePost,
    toggleReaction
} = require('../controllers/post.controller');

// Rutas base: /api/posts
router.get('/', protect, getPosts);
// `singleAttachment` acepta imágenes y además documentos, que es lo que
// necesitan las entregas de tareas. El controlador distingue entre ambos.
router.post('/', protect, singleAttachment('image'), createPost);
router.put('/:id/like', protect, toggleLike);
router.put('/:id/react/:type', protect, toggleReaction);
router.post('/:id/comment', protect, addComment);
router.delete('/:id', protect, deletePost);

module.exports = router;