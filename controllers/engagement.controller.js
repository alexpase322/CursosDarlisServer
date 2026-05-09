const User = require('../models/User');
const { achievements, TIERS } = require('../config/achievementsConfig');
const { recalculateAllUsers } = require('../services/engagementService');

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

        res.json({
            currentStreak: user.currentStreak || 0,
            longestStreak: user.longestStreak || 0,
            lastActiveAt: user.lastActiveAt,
            topAchievementTier: user.topAchievementTier || null,
            topAchievementCode: user.topAchievementCode || null,
            topAchievement: topDef ? { code: user.topAchievementCode, ...topDef } : null,
            tiers: TIERS,
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
