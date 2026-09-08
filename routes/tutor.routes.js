const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { protect, admin } = require('../middleware/authMiddleware');
const { ask, available, health } = require('../controllers/tutor.controller');

// Cada pregunta ocupa la GPU del servidor propio unos segundos. El límite es
// por alumna (no por IP) para que varias desde la misma red o el mismo móvil
// no se bloqueen entre ellas.
const tutorLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    // `protect` corre antes, así que normalmente hay usuaria. La reserva por IP
    // pasa por ipKeyGenerator: agrupa el /56 de IPv6, porque con la IP cruda
    // basta cambiar de dirección dentro del mismo rango para saltarse el límite.
    keyGenerator: (req) => (req.user?._id ? String(req.user._id) : ipKeyGenerator(req.ip)),
    message: { message: 'Has hecho muchas preguntas seguidas. Espera unos minutos y sigue.' }
});

router.get('/available', protect, available);
router.post('/ask', protect, tutorLimiter, ask);
router.get('/health', protect, admin, health);

module.exports = router;
