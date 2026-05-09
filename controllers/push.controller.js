const PushSubscription = require('../models/PushSubscription');

// GET /push/public-key  — retorna la VAPID public key (necesaria en el navegador).
const getPublicKey = (req, res) => {
    const key = process.env.VAPID_PUBLIC_KEY;
    if (!key) return res.status(503).json({ message: 'Push no configurado' });
    res.json({ publicKey: key });
};

// POST /push/subscribe  — guarda la suscripción del navegador.
const subscribe = async (req, res) => {
    try {
        const { endpoint, keys } = req.body || {};
        if (!endpoint || !keys?.p256dh || !keys?.auth) {
            return res.status(400).json({ message: 'Suscripción inválida' });
        }
        await PushSubscription.findOneAndUpdate(
            { endpoint },
            {
                user: req.user._id,
                endpoint,
                keys: { p256dh: keys.p256dh, auth: keys.auth },
                userAgent: req.headers['user-agent'] || '',
                lastSeenAt: new Date()
            },
            { upsert: true, new: true }
        );
        res.json({ ok: true });
    } catch (err) {
        console.error('subscribe push:', err);
        res.status(500).json({ message: 'Error al suscribir' });
    }
};

// POST /push/unsubscribe
const unsubscribe = async (req, res) => {
    try {
        const { endpoint } = req.body || {};
        if (!endpoint) return res.status(400).json({ message: 'Endpoint requerido' });
        await PushSubscription.deleteOne({ endpoint, user: req.user._id });
        res.json({ ok: true });
    } catch (err) {
        console.error('unsubscribe push:', err);
        res.status(500).json({ message: 'Error al desuscribir' });
    }
};

module.exports = { getPublicKey, subscribe, unsubscribe };
