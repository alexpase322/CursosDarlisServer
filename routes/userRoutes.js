const express = require('express');
const router = express.Router();
const { updateUserProfile, getAllUsers, updateUserRole, deleteUser } = require('../controllers/userController');
const { protect, admin } = require('../middleware/authMiddleware');
const multer = require('multer');

// Configuración básica de Multer (Guarda temporalmente en carpeta 'uploads/')
const upload = multer({ dest: 'uploads/' });

// PUT /api/users/profile
// protect: verifica token
// upload.single('image'): busca un campo llamado 'image' con un archivo
// updateUserProfile: nuestra lógica
router.put('/profile', protect, upload.single('image'), updateUserProfile);
router.get('/', protect, admin, getAllUsers);
router.put('/:id/role', protect, admin, updateUserRole);
router.delete('/:id', protect, admin, deleteUser);


module.exports = router;