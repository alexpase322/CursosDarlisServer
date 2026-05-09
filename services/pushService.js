// Servicio de Web Push notifications (VAPID).
// Lee VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY del entorno.
// Si faltan, los envíos no fallan: solo loguean.

const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');
const User = require('../models/User');

let vapidConfigured = false;

function configureVapid() {
    if (vapidConfigured) return true;
    const pub = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT || 'mailto:soporte@arquitectadetupropioexito.com';
    if (!pub || !priv) return false;
    webpush.setVapidDetails(subject, pub, priv);
    vapidConfigured = true;
    return true;
}

// Enviar push a un usuario (todos sus dispositivos suscritos).
async function sendToUser(userId, payload) {
    if (!configureVapid()) {
        console.warn('[push] VAPID keys ausentes; skip envío.');
        return { sent: 0, failed: 0 };
    }
    const subs = await PushSubscription.find({ user: userId });
    return sendToSubs(subs, payload);
}

// Enviar push a varios usuarios.
async function sendToUsers(userIds, payload) {
    if (!configureVapid()) return { sent: 0, failed: 0 };
    const subs = await PushSubscription.find({ user: { $in: userIds } });
    return sendToSubs(subs, payload);
}

// Enviar a todos los admins.
async function sendToAdmins(payload) {
    if (!configureVapid()) return { sent: 0, failed: 0 };
    const admins = await User.find({ role: 'admin' }).select('_id').lean();
    return sendToUsers(admins.map(a => a._id), payload);
}

async function sendToSubs(subs, payload) {
    let sent = 0, failed = 0;
    const json = JSON.stringify(payload);
    for (const s of subs) {
        try {
            await webpush.sendNotification({
                endpoint: s.endpoint,
                keys: s.keys
            }, json);
            sent += 1;
        } catch (err) {
            failed += 1;
            // 410 Gone / 404 → suscripción muerta, la borramos.
            if (err.statusCode === 410 || err.statusCode === 404) {
                await PushSubscription.deleteOne({ _id: s._id });
            } else {
                console.error('[push] error envío:', err.statusCode, err.body || err.message);
            }
        }
    }
    return { sent, failed };
}

module.exports = { sendToUser, sendToUsers, sendToAdmins, configureVapid };
