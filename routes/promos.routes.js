const express = require('express');
const router = express.Router();
const { getPublicPromo } = require('../controllers/admin.promos.controller');

// Endpoint público para la landing/checkout — muestra promos activas.
router.get('/active', getPublicPromo);

module.exports = router;
