const express = require('express');
const router = express.Router();
const { updateUserProfile, getAllUsers, updateUserRole, deleteUser } = require('../controllers/userController');
const { protect, admin } = require('../middleware/authMiddleware');
const { singleImage } = require('../config/upload');

// PUT /api/users/profile
// protect: verifica token · singleImage: valida tamaño/tipo de la imagen
router.put('/profile', protect, singleImage('image'), updateUserProfile);
router.get('/', protect, admin, getAllUsers);
router.put('/:id/role', protect, admin, updateUserRole);
router.delete('/:id', protect, admin, deleteUser);


module.exports = router;