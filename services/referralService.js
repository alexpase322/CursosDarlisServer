// Gestión de códigos de referido (el link único de cada afiliada).
// Formato: <slug-del-nombre>-<4 chars aleatorios>  →  ej. "darlis-a3f9"

const crypto = require('crypto');
const User = require('../models/User');

// Convierte "María José Pérez" → "maria-jose-perez"
function slugify(text) {
    return String(text || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')   // quita acentos/diacríticos
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 20) || 'partner';
}

const randomSuffix = () => crypto.randomBytes(3).toString('hex').slice(0, 4);

// Genera un código único (reintenta si colisiona).
async function generateUniqueCode(baseName) {
    const base = slugify(baseName);
    for (let i = 0; i < 8; i++) {
        const code = `${base}-${randomSuffix()}`;
        const exists = await User.exists({ referralCode: code });
        if (!exists) return code;
    }
    // Fallback improbable: código totalmente aleatorio.
    return `ref-${crypto.randomBytes(6).toString('hex')}`;
}

// Asegura que la usuaria tenga un referralCode. Idempotente: si ya lo tiene, lo devuelve.
async function ensureReferralCode(userOrId) {
    const user = typeof userOrId === 'object' && userOrId._id
        ? userOrId
        : await User.findById(userOrId);
    if (!user) return null;
    if (user.referralCode) return user.referralCode;

    const code = await generateUniqueCode(user.username || user.email);
    try {
        await User.updateOne({ _id: user._id }, { $set: { referralCode: code } });
        user.referralCode = code;
        return code;
    } catch (err) {
        // Colisión en el índice único: reintentamos una vez leyendo el valor actual.
        if (err.code === 11000) {
            const fresh = await User.findById(user._id).select('referralCode').lean();
            if (fresh?.referralCode) return fresh.referralCode;
            const retry = await generateUniqueCode(`${user.username || 'partner'}${randomSuffix()}`);
            await User.updateOne({ _id: user._id }, { $set: { referralCode: retry } });
            return retry;
        }
        throw err;
    }
}

// Resuelve un código → afiliada válida (debe ser Partner N2+ y estar activa).
async function resolveReferralCode(code) {
    if (!code || typeof code !== 'string') return null;
    const clean = code.trim().toLowerCase().slice(0, 60);
    if (!clean) return null;
    const user = await User.findOne({ referralCode: clean })
        .select('username avatar partnerLevel status referralCode')
        .lean();
    if (!user) return null;
    if ((user.partnerLevel || 1) < 2) return null; // solo afiliadas activas
    return user;
}

// Genera códigos para todas las afiliadas N2+ que aún no lo tengan.
async function backfillReferralCodes() {
    const partners = await User.find({
        partnerLevel: { $gte: 2 },
        $or: [{ referralCode: null }, { referralCode: { $exists: false } }]
    }).select('_id username email').lean();

    let created = 0;
    for (const p of partners) {
        try {
            await ensureReferralCode(p);
            created += 1;
        } catch (err) {
            console.error('backfillReferralCodes', p._id, err.message);
        }
    }
    return { scanned: partners.length, created };
}

const buildReferralLink = (code) => {
    const base = process.env.FRONTEND_URL || 'https://arquitectadetupropioexito.com';
    return `${base.replace(/\/+$/, '')}/r/${code}`;
};

module.exports = {
    ensureReferralCode,
    resolveReferralCode,
    backfillReferralCodes,
    buildReferralLink,
    slugify
};
