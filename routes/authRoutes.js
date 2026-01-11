const express = require('express');
const router = express.Router();
const { registerUser, loginUser, getProfile, inviteUser, completeProfile, resetPassword, forgotPassword } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware'); // Importar middleware
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

router.post('/register', registerUser); // Deberíamos proteger el registro también si solo admins registran
router.post('/login', loginUser);

// Ruta protegida: Solo accesible con token válido
router.get('/profile', protect, getProfile);
router.post('/invite', protect, inviteUser);
router.post('/complete-profile/:token', upload.single('image'), completeProfile);
router.post('/forgot-password', forgotPassword); // <--- NUEVA
router.put('/reset-password/:token', resetPassword); // <--- NUEVA

module.exports = router;