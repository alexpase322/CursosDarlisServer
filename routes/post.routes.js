const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const { 
    getPosts, 
    createPost, 
    toggleLike, 
    addComment, 
    deletePost 
} = require('../controllers/post.controller');

// Rutas base: /api/posts
router.get('/', protect, getPosts);
router.post('/', protect, upload.single('image'), createPost);
router.put('/:id/like', protect, toggleLike);
router.post('/:id/comment', protect, addComment);
router.delete('/:id', protect, deletePost);

module.exports = router;