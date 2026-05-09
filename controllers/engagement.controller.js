const User = require('../models/User');
const { achievements } = require('../config/achievementsConfig');

// GET /engagement/me  → racha + logros desbloqueados + bloqueados
const getMyEngagement = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select(
            'currentStreak longestStreak lastActiveAt achievements'
        ).lean();
        if (!user) return res.status(404).json({ message: 'No encontrado' });

        const unlockedMap = new Map((user.achievements || []).map(a => [a.code, a.unlockedAt]));
        const all = Object.entries(achievements).map(([code, def]) => ({
            code,
            ...def,
            unlocked: unlockedMap.has(code),
            unlockedAt: unlockedMap.get(code) || null
        }));

        res.json({
            currentStreak: user.currentStreak || 0,
            longestStreak: user.longestStreak || 0,
            lastActiveAt: user.lastActiveAt,
            achievements: all
        });
    } catch (err) {
        console.error('getMyEngagement', err);
        res.status(500).json({ message: 'Error al obtener engagement' });
    }
};

module.exports = { getMyEngagement };
