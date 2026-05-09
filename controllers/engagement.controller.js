const User = require('../models/User');
const { achievements, TIERS } = require('../config/achievementsConfig');
const { recalculateAllUsers, computeTopTier } = require('../services/engagementService');

// Umbral de logros por tier para promocionar (debe coincidir con engagementService).
const TIER_THRESHOLD = 3;
const TIER_ORDER = ['bronze', 'silver', 'gold', 'diamond'];

// GET /engagement/me  → racha + logros desbloqueados + bloqueados + tier top
const getMyEngagement = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select(
            'currentStreak longestStreak lastActiveAt achievements topAchievementTier topAchievementCode'
        ).lean();
        if (!user) return res.status(404).json({ message: 'No encontrado' });

        const unlockedMap = new Map((user.achievements || []).map(a => [a.code, a.unlockedAt]));
        const all = Object.entries(achievements).map(([code, def]) => ({
            code,
            ...def,
            unlocked: unlockedMap.has(code),
            unlockedAt: unlockedMap.get(code) || null
        }));
        // Ordenar: desbloqueados primero, luego por tier descendente.
        const tierRank = { diamond: 4, gold: 3, silver: 2, bronze: 1 };
        all.sort((a, b) => {
            if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
            return (tierRank[b.tier] || 0) - (tierRank[a.tier] || 0);
        });

        const topDef = user.topAchievementCode ? achievements[user.topAchievementCode] : null;

        // Progreso por tier — cuántos logros desbloqueó vs requeridos para alcanzarlo.
        const { counts } = computeTopTier(user.achievements);
        const totalsByTier = TIER_ORDER.reduce((acc, t) => {
            acc[t] = Object.values(achievements).filter(a => a.tier === t).length;
            return acc;
        }, {});
        const tierProgress = TIER_ORDER.map(t => ({
            tier: t,
            unlocked: counts[t] || 0,
            required: TIER_THRESHOLD,
            available: totalsByTier[t] || 0,
            achieved: (counts[t] || 0) >= TIER_THRESHOLD,
            isCurrent: user.topAchievementTier === t
        }));

        res.json({
            currentStreak: user.currentStreak || 0,
            longestStreak: user.longestStreak || 0,
            lastActiveAt: user.lastActiveAt,
            topAchievementTier: user.topAchievementTier || null,
            topAchievementCode: user.topAchievementCode || null,
            topAchievement: topDef ? { code: user.topAchievementCode, ...topDef } : null,
            tiers: TIERS,
            tierThreshold: TIER_THRESHOLD,
            tierProgress,
            achievements: all,
            summary: {
                unlockedCount: all.filter(a => a.unlocked).length,
                totalCount: all.length
            }
        });
    } catch (err) {
        console.error('getMyEngagement', err);
        res.status(500).json({ message: 'Error al obtener engagement' });
    }
};

// POST /admin/achievements/recalculate-all
const recalculateAllAchievements = async (req, res) => {
    try {
        const r = await recalculateAllUsers();
        res.json({ ok: true, ...r });
    } catch (err) {
        console.error('recalculateAllAchievements', err);
        res.status(500).json({ message: 'Error al recalcular logros' });
    }
};

module.exports = { getMyEngagement, recalculateAllAchievements };
