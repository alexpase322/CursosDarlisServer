const express = require('express');
const router = express.Router();
const { createCheckoutSession, stripeWebhook } = require('../controllers/payment.controller');
const expressRaw = require('express'); // Necesario para el webhook

// Ruta para el frontend (Crear link de pago)
router.post('/create-checkout-session', createCheckoutSession);
// Ruta para Stripe (Webhook)
// IMPORTANTE: El webhook necesita el body en formato RAW (sin parsar a JSON)
// Esto lo configuraremos en el index.js principal mejor, aquí solo definimos la ruta
// Pero para mantener orden, definimos que esta ruta existe.

module.exports = router;