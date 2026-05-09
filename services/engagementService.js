// Engagement: racha de días + desbloqueo de logros.
// El "ping" de actividad lo hace el authMiddleware en cada request autenticado.

const User = require('../models/User');
const { achievements } = require('../config/achievementsConfig');
const { sendToUser } = require('./pushService');

const todayUtcKey = () => new Date().toISOString().slice(0, 10);
const yesterdayUtcKey = () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
};

// Llamado en cada request: actualiza racha + lastActiveAt si no se hizo hoy.
// Idempotente: si ya pingeó hoy, sale rápido.
async function pingActivity(userId) {
    if (!userId) return null;
    const today = todayUtcKey();
    const user = await User.findById(userId).select(
        'streakLastIncrementDay currentStreak longestStreak achievements lastActiveAt'
    );
    if (!user) return null;
    if (user.streakLastIncrementDay === today) {
        // Solo refrescamos lastActiveAt, no incrementamos racha 2 veces el mismo día.
        if (!user.lastActiveAt || (Date.now() - user.lastActiveAt.getTime()) > 60 * 60 * 1000) {
            await User.updateOne({ _id: userId }, { $set: { lastActiveAt: new Date() } });
        }
        return null;
    }

    const yest = yesterdayUtcKey();
    const newStreak = user.streakLastIncrementDay === yest ? (user.currentStreak || 0) + 1 : 1;
    const longest = Math.max(user.longestStreak || 0, newStreak);

    user.streakLastIncrementDay = today;
    user.currentStreak = newStreak;
    user.longestStreak = longest;
    user.lastActiveAt = new Date();

    // Logros automáticos por racha + first_login
    const unlocked = [];
    const has = (code) => user.achievements.some(a => a.code === code);
    if (!has('first_login')) unlocked.push('first_login');
    if (newStreak >= 3 && !has('streak_3')) unlocked.push('streak_3');
    if (newStreak >= 7 && !has('streak_7')) unlocked.push('streak_7');
    if (newStreak >= 30 && !has('streak_30')) unlocked.push('streak_30');

    for (const code of unlocked) {
        user.achievements.push({ code, unlockedAt: new Date() });
    }

    await user.save();

    // Notificar push de cada logro nuevo (no bloquea)
    for (const code of unlocked) {
        const def = achievements[code];
        if (!def) continue;
        sendToUser(userId, {
            title: `${def.icon} Logro desbloqueado`,
            body: `${def.title} — ${def.description}`,
            url: '/perfil',
            tag: `achievement-${code}`
        }).catch(() => {});
    }

    return { newStreak, longest, unlocked };
}

// Desbloquear logro programáticamente (idempotente).
async function unlockAchievement(userId, code, meta = {}) {
    const def = achievements[code];
    if (!def) return null;
    const result = await User.updateOne(
        { _id: userId, 'achievements.code': { $ne: code } },
        { $push: { achievements: { code, unlockedAt: new Date(), meta } } }
    );
    if (result.modifiedCount > 0) {
        sendToUser(userId, {
            title: `${def.icon} Logro desbloqueado`,
            body: `${def.title} — ${def.description}`,
            url: '/perfil',
            tag: `achievement-${code}`
        }).catch(() => {});
        return code;
    }
    return null;
}

module.exports = { pingActivity, unlockAchievement };
