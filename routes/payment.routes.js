const express = require('express');
const router = express.Router();
const { createCheckoutSession, stripeWebhook, createBillingPortalSession } = require('../controllers/payment.controller');
const { protect } = require('../middleware/authMiddleware');
const expressRaw = require('express'); // Necesario para el webhook

// Ruta para el frontend (Crear link de pago)
router.post('/create-checkout-session', createCheckoutSession);

// Portal de pagos de Stripe (gestionar suscripción, método de pago, facturas)
router.post('/portal', protect, createBillingPortalSession);
// Ruta para Stripe (Webhook)
// IMPORTANTE: El webhook necesita el body en formato RAW (sin parsar a JSON)
// Esto lo configuraremos en el index.js principal mejor, aquí solo definimos la ruta
// Pero para mantener orden, definimos que esta ruta existe.

module.exports = router;