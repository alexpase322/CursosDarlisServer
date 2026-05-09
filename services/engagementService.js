// Engagement: racha de días, logros automáticos y por hito (milestones).
// El "ping" de actividad lo hace el authMiddleware en cada request autenticado.

const User = require('../models/User');
const QuizAttempt = require('../models/QuizAttempt');
const Commission = require('../models/Commission');
const Post = require('../models/Post');
const { achievements, TIERS } = require('../config/achievementsConfig');
const { sendToUser } = require('./pushService');

const todayUtcKey = () => new Date().toISOString().slice(0, 10);
const yesterdayUtcKey = () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
};

// ISO week key: 'YYYY-WW' + dayOfWeek (1-7)
function isoWeekDayKey(date = new Date()) {
    const d = new Date(date);
    d.setUTCHours(0, 0, 0, 0);
    const day = (d.getUTCDay() + 6) % 7; // L=0...D=6
    d.setUTCDate(d.getUTCDate() - day + 3);
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    return { weekKey: `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`, dow: day };
}

// Mapa de orden de tiers para comparar.
const tierRank = (t) => (t && TIERS[t]?.rank) || 0;

// Umbral mínimo de logros DE UN MISMO TIER para alcanzar ese tier.
// Ej: 3 logros bronze desbloqueados → tier bronze. 3 silver → silver. Etc.
const TIER_THRESHOLD = 3;
const TIER_ORDER = ['bronze', 'silver', 'gold', 'diamond'];

// Cuenta logros desbloqueados por tier.
function countByTier(userAchievements = []) {
    const counts = { bronze: 0, silver: 0, gold: 0, diamond: 0 };
    for (const ua of userAchievements) {
        const def = achievements[ua.code];
        if (def && def.tier && counts[def.tier] !== undefined) {
            counts[def.tier] += 1;
        }
    }
    return counts;
}

// El tier más alto que la usuaria ha "ganado" (tiene ≥ TIER_THRESHOLD logros de él).
// Si no llega al umbral en ningún tier → null (sin marco).
function computeTopTier(userAchievements = []) {
    const counts = countByTier(userAchievements);
    let topTier = null;
    for (const t of TIER_ORDER) {
        if (counts[t] >= TIER_THRESHOLD) topTier = t;
    }
    // Pick a representative achievement code de ese tier (el más reciente).
    let topCode = null;
    if (topTier) {
        const ofTier = userAchievements
            .filter(ua => achievements[ua.code]?.tier === topTier)
            .sort((a, b) => new Date(b.unlockedAt) - new Date(a.unlockedAt));
        topCode = ofTier[0]?.code || null;
    }
    return { topTier, topCode, counts };
}

async function refreshTopTier(user) {
    const { topTier, topCode } = computeTopTier(user.achievements);
    if (user.topAchievementTier !== topTier || user.topAchievementCode !== topCode) {
        user.topAchievementTier = topTier;
        user.topAchievementCode = topCode;
    }
}

// Llamado en cada request autenticado.
// Idempotente por día UTC (no incrementa la racha 2 veces el mismo día).
async function pingActivity(userId) {
    if (!userId) return null;
    const today = todayUtcKey();
    const user = await User.findById(userId).select(
        'streakLastIncrementDay currentStreak longestStreak achievements lastActiveAt earlyLoginCount lateLoginCount weekDaysSet topAchievementTier topAchievementCode'
    );
    if (!user) return null;

    const now = new Date();
    const hour = now.getUTCHours();
    let updated = false;
    const newlyUnlocked = [];

    // ── Easter eggs por hora (idempotencia loose: solo cuenta una vez por día) ──
    if (user.streakLastIncrementDay !== today) {
        // Solo cuando es el primer ping del día consideramos hora como representativa.
        // No acumula 2 veces el mismo día.
        if (hour < 7) {
            user.earlyLoginCount = (user.earlyLoginCount || 0) + 1;
            if (user.earlyLoginCount >= 5 && !hasAchievement(user, 'early_bird')) {
                user.achievements.push({ code: 'early_bird', unlockedAt: now });
                newlyUnlocked.push('early_bird');
            }
        } else if (hour >= 23) {
            user.lateLoginCount = (user.lateLoginCount || 0) + 1;
            if (user.lateLoginCount >= 5 && !hasAchievement(user, 'night_owl')) {
                user.achievements.push({ code: 'night_owl', unlockedAt: now });
                newlyUnlocked.push('night_owl');
            }
        }
    }

    // ── Full week: registramos qué día de la semana entró ──
    const { weekKey, dow } = isoWeekDayKey(now);
    const dayKey = `${weekKey}-${dow}`;
    if (!user.weekDaysSet.includes(dayKey)) {
        user.weekDaysSet.push(dayKey);
        // Solo guardamos las últimas 2 semanas para no crecer infinito.
        if (user.weekDaysSet.length > 14) user.weekDaysSet = user.weekDaysSet.slice(-14);

        const daysThisWeek = user.weekDaysSet.filter(k => k.startsWith(weekKey)).length;
        if (daysThisWeek >= 7 && !hasAchievement(user, 'full_week')) {
            user.achievements.push({ code: 'full_week', unlockedAt: now });
            newlyUnlocked.push('full_week');
        }
        updated = true;
    }

    // ── Racha + first_login ──
    if (user.streakLastIncrementDay === today) {
        // Mismo día → solo refrescar lastActiveAt si pasó >1h
        if (!user.lastActiveAt || (Date.now() - user.lastActiveAt.getTime()) > 60 * 60 * 1000) {
            user.lastActiveAt = now;
            updated = true;
        }
    } else {
        const yest = yesterdayUtcKey();
        const newStreak = user.streakLastIncrementDay === yest ? (user.currentStreak || 0) + 1 : 1;
        const longest = Math.max(user.longestStreak || 0, newStreak);

        user.streakLastIncrementDay = today;
        user.currentStreak = newStreak;
        user.longestStreak = longest;
        user.lastActiveAt = now;
        updated = true;

        if (!hasAchievement(user, 'first_login')) {
            user.achievements.push({ code: 'first_login', unlockedAt: now });
            newlyUnlocked.push('first_login');
        }
        const streakUnlocks = [
            { n: 3,   code: 'streak_3' },
            { n: 7,   code: 'streak_7' },
            { n: 30,  code: 'streak_30' },
            { n: 60,  code: 'streak_60' },
            { n: 100, code: 'streak_100' },
            { n: 365, code: 'streak_365' }
        ];
        for (const s of streakUnlocks) {
            if (newStreak >= s.n && !hasAchievement(user, s.code)) {
                user.achievements.push({ code: s.code, unlockedAt: now });
                newlyUnlocked.push(s.code);
            }
        }
    }

    // Auto-fix: si tiene achievements pero el topAchievementTier está vacío
    // (caso típico al añadir el campo retroactivamente), lo recalculamos.
    const needsTierBackfill =
        (user.achievements?.length || 0) > 0 && !user.topAchievementTier;

    if (newlyUnlocked.length > 0 || updated || needsTierBackfill) {
        await refreshTopTier(user);
        await user.save();
        for (const code of newlyUnlocked) notifyUnlock(userId, code);
    }
    return { newlyUnlocked, currentStreak: user.currentStreak };
}

const hasAchievement = (user, code) => (user.achievements || []).some(a => a.code === code);

function notifyUnlock(userId, code) {
    const def = achievements[code];
    if (!def) return;
    sendToUser(userId, {
        title: `${def.icon} Logro desbloqueado`,
        body: `${def.title} — ${def.description}`,
        url: '/perfil',
        tag: `achievement-${code}`
    }).catch(() => {});
}

// Desbloquear logro programáticamente (idempotente).
async function unlockAchievement(userId, code, meta = {}) {
    const def = achievements[code];
    if (!def) return null;
    const user = await User.findById(userId).select('achievements topAchievementTier topAchievementCode');
    if (!user) return null;
    if (hasAchievement(user, code)) return null;
    user.achievements.push({ code, unlockedAt: new Date(), meta });
    await refreshTopTier(user);
    await user.save();
    notifyUnlock(userId, code);
    return code;
}

// Re-evalúa milestones acumulativos de un usuario (cursos completados, referidas,
// comisiones, USD ganado, posts, comentarios). Llamado tras eventos relevantes.
async function evaluateMilestones(userId) {
    const user = await User.findById(userId).select('_id achievements topAchievementTier topAchievementCode');
    if (!user) return;

    const newlyUnlocked = [];

    // ── Cursos completados (distinct courses con quiz aprobado) ──
    const passedCourses = await QuizAttempt.distinct('course', { user: userId, passed: true });
    const nCourses = passedCourses.length;
    if (nCourses >= 1 && !hasAchievement(user, 'course_completed')) newlyUnlocked.push('course_completed');
    if (nCourses >= 5 && !hasAchievement(user, 'five_courses')) newlyUnlocked.push('five_courses');
    if (nCourses >= 10 && !hasAchievement(user, 'ten_courses')) newlyUnlocked.push('ten_courses');
    if (nCourses >= 20 && !hasAchievement(user, 'twenty_courses')) newlyUnlocked.push('twenty_courses');

    // ── Referidas (count) ──
    const totalReferrals = await User.countDocuments({ referredBy: userId });
    if (totalReferrals >= 1 && !hasAchievement(user, 'first_referral')) newlyUnlocked.push('first_referral');
    if (totalReferrals >= 10 && !hasAchievement(user, 'ten_referrals')) newlyUnlocked.push('ten_referrals');
    if (totalReferrals >= 25 && !hasAchievement(user, 'twenty_five_referrals')) newlyUnlocked.push('twenty_five_referrals');
    if (totalReferrals >= 50 && !hasAchievement(user, 'fifty_referrals')) newlyUnlocked.push('fifty_referrals');
    if (totalReferrals >= 100 && !hasAchievement(user, 'hundred_referrals')) newlyUnlocked.push('hundred_referrals');

    // ── Comisiones (count + USD) ──
    const commAgg = await Commission.aggregate([
        { $match: { affiliate: user._id, status: { $ne: 'voided' } } },
        { $group: { _id: null, count: { $sum: 1 }, totalUSD: { $sum: '$commissionAmountUSD' } } }
    ]);
    const commCount = commAgg[0]?.count || 0;
    const commUSD = commAgg[0]?.totalUSD || 0;
    if (commCount >= 1 && !hasAchievement(user, 'first_commission')) newlyUnlocked.push('first_commission');
    if (commCount >= 5 && !hasAchievement(user, 'five_commissions')) newlyUnlocked.push('five_commissions');
    if (commCount >= 20 && !hasAchievement(user, 'twenty_commissions')) newlyUnlocked.push('twenty_commissions');
    if (commCount >= 50 && !hasAchievement(user, 'fifty_commissions')) newlyUnlocked.push('fifty_commissions');
    if (commUSD >= 100 && !hasAchievement(user, 'earned_100')) newlyUnlocked.push('earned_100');
    if (commUSD >= 500 && !hasAchievement(user, 'earned_500')) newlyUnlocked.push('earned_500');
    if (commUSD >= 1000 && !hasAchievement(user, 'earned_1000')) newlyUnlocked.push('earned_1000');
    if (commUSD >= 5000 && !hasAchievement(user, 'earned_5000')) newlyUnlocked.push('earned_5000');

    // ── Posts y comentarios ──
    const postCount = await Post.countDocuments({ author: userId });
    if (postCount >= 1 && !hasAchievement(user, 'first_post')) newlyUnlocked.push('first_post');
    if (postCount >= 10 && !hasAchievement(user, 'ten_posts')) newlyUnlocked.push('ten_posts');
    if (postCount >= 50 && !hasAchievement(user, 'fifty_posts')) newlyUnlocked.push('fifty_posts');

    const commentAgg = await Post.aggregate([
        { $unwind: '$comments' },
        { $match: { 'comments.user': user._id } },
        { $count: 'n' }
    ]);
    const commentCount = commentAgg[0]?.n || 0;
    if (commentCount >= 1 && !hasAchievement(user, 'first_comment')) newlyUnlocked.push('first_comment');
    if (commentCount >= 50 && !hasAchievement(user, 'fifty_comments')) newlyUnlocked.push('fifty_comments');

    // Niveles partner (los lee del User actual)
    const userLevel = await User.findById(userId).select('partnerLevel');
    if (userLevel?.partnerLevel >= 2 && !hasAchievement(user, 'partner_activated')) newlyUnlocked.push('partner_activated');
    if (userLevel?.partnerLevel >= 3 && !hasAchievement(user, 'partner_n3')) newlyUnlocked.push('partner_n3');
    if (userLevel?.partnerLevel >= 4 && !hasAchievement(user, 'partner_n4')) newlyUnlocked.push('partner_n4');

    if (newlyUnlocked.length === 0) return;

    for (const code of newlyUnlocked) {
        user.achievements.push({ code, unlockedAt: new Date() });
    }
    await refreshTopTier(user);
    await user.save();
    for (const code of newlyUnlocked) notifyUnlock(userId, code);
    return newlyUnlocked;
}

// POST /admin/achievements/recalculate-all  — escanea TODAS las usuarias y:
//   1) desbloquea los logros que les correspondan según su data actual
//   2) recalcula el topAchievementTier con la regla actual (≥3 logros por tier)
async function recalculateAllUsers() {
    const users = await User.find({ role: { $ne: 'admin' } }).select('_id').lean();
    let processed = 0, totalUnlocked = 0, tierChanged = 0, tierCleared = 0, tierUpgraded = 0;

    for (const u of users) {
        // Paso 1: evaluar y desbloquear nuevos logros
        const newlyUnlocked = await evaluateMilestones(u._id);
        if (newlyUnlocked) totalUnlocked += newlyUnlocked.length;

        // Paso 2: forzar refresh del tier (incluso sin nuevos logros, porque la regla
        // de promoción cambió y el tier almacenado puede estar desfasado).
        const user = await User.findById(u._id).select(
            'achievements topAchievementTier topAchievementCode'
        );
        if (!user) continue;
        const previousTier = user.topAchievementTier || null;
        await refreshTopTier(user);
        if (user.topAchievementTier !== previousTier) {
            tierChanged += 1;
            if (!user.topAchievementTier && previousTier) tierCleared += 1;
            else if (
                tierRank(user.topAchievementTier) > tierRank(previousTier)
            ) tierUpgraded += 1;
            await user.save();
        }
        processed += 1;
    }

    return { processed, totalUnlocked, tierChanged, tierCleared, tierUpgraded };
}

module.exports = {
    pingActivity, unlockAchievement, evaluateMilestones,
    recalculateAllUsers, computeTopTier
};
