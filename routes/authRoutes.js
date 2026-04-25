const express = require('express');
const router = express.Router();
const { registerUser, loginUser, getProfile, inviteUser, completeProfile, resetPassword, forgotPassword, listPublicAffiliates } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

router.post('/register', registerUser);
router.post('/login', loginUser);

// Pública: dropdown de afiliadas en SetupAccount
router.get('/affiliates-public', listPublicAffiliates);

// Ruta protegida: Solo accesible con token válido
router.get('/profile', protect, getProfile);
router.post('/invite', protect, inviteUser);
router.post('/complete-profile/:token', upload.single('image'), completeProfile);
router.post('/forgot-password', forgotPassword);
router.put('/reset-password/:token', resetPassword);

module.exports = router;
