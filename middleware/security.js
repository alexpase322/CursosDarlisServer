// Middleware central de seguridad.
// Compatible con Express 5 (no reasigna req.query, que es getter-only).

const { rateLimit } = require('express-rate-limit');

// ─────────────────────────────────────────────────────────────
// 1. Sanitización NoSQL (anti operator-injection: $gt, $ne, $where…)
// Elimina IN PLACE cualquier clave que empiece con '$' o contenga '.'
// de req.body, req.query y req.params. No reasigna los objetos, así que
// funciona con Express 5 (donde req.query es de solo lectura).
// ─────────────────────────────────────────────────────────────
function sanitizeInPlace(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return;
    for (const key of Object.keys(obj)) {
        if (key.startsWith('$') || key.includes('.')) {
            delete obj[key];
            continue;
        }
        const val = obj[key];
        if (val && typeof val === 'object') sanitizeInPlace(val, depth + 1);
    }
}

const mongoSanitize = (req, res, next) => {
    try {
        if (req.body) sanitizeInPlace(req.body);
        if (req.params) sanitizeInPlace(req.params);
        // req.query en Express 5 es getter-only: mutamos sus propiedades sin reasignar.
        if (req.query && typeof req.query === 'object') sanitizeInPlace(req.query);
    } catch (e) {
        // Nunca romper la request por el sanitizer.
    }
    next();
};

// ─────────────────────────────────────────────────────────────
// 2. Escape de regex (anti-ReDoS y regex-injection en búsquedas)
// ─────────────────────────────────────────────────────────────
const escapeRegex = (s) => String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Construye un filtro de búsqueda seguro y acotado (limita longitud del término).
const safeSearchRegex = (term, maxLen = 80) => {
    const clean = String(term || '').trim().slice(0, maxLen);
    return { $regex: escapeRegex(clean), $options: 'i' };
};

// ─────────────────────────────────────────────────────────────
// 3. Rate limiters
// ─────────────────────────────────────────────────────────────
const baseOptions = {
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Detrás de un proxy (Render/Railway/Vercel) el IP real viene en X-Forwarded-For.
    // Requiere app.set('trust proxy', 1) — configurado en index.js.
};

// General: protege toda la API de un flood. Techo alto porque el SPA hace
// muchas peticiones XHR y varios usuarios pueden compartir IP (NAT móvil).
const generalLimiter = rateLimit({
    ...baseOptions,
    windowMs: 15 * 60 * 1000,   // 15 min
    max: 1500,                   // 1500 req / 15 min por IP
    message: { message: 'Demasiadas solicitudes, intenta más tarde.' }
});

// Estricto: login, registro, reset de contraseña (anti fuerza bruta).
const authLimiter = rateLimit({
    ...baseOptions,
    windowMs: 15 * 60 * 1000,
    max: 20,                     // 20 intentos / 15 min por IP
    message: { message: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.' },
    skipSuccessfulRequests: true // solo cuenta intentos fallidos
});

// Formularios públicos (contacto, webinar, invitados): anti-spam.
const publicFormLimiter = rateLimit({
    ...baseOptions,
    windowMs: 60 * 60 * 1000,    // 1 hora
    max: 15,                     // 15 envíos / hora por IP
    message: { message: 'Has enviado demasiadas solicitudes. Intenta más tarde.' }
});

module.exports = {
    mongoSanitize,
    escapeRegex,
    safeSearchRegex,
    generalLimiter,
    authLimiter,
    publicFormLimiter
};
