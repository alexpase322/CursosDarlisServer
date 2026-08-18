const User = require('../models/User');
const { achievements, TIERS } = require('../config/achievementsConfig');
const { recalculateAllUsers, computeTopTier } = require('../services/engagementService');
const { recalculateAllRanks } = require('../services/rankService');
const { ranks, rankForAmount, byCode, rankProgress } = require('../config/rankConfig');
const Commission = require('../models/Commission');

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

// POST /admin/ranks/recalculate-all
// Recalcula el rango de todas las afiliadas a partir de su total facturado.
// Sirve para sembrar los rangos la primera vez y tras ajustes de comisiones.
// `notify=1` avisa por push a quienes suban de rango (por defecto NO, para no
// mandar una avalancha de notificaciones en el primer sembrado).
const recalculateAllRanksEndpoint = async (req, res) => {
    try {
        const notify = req.query.notify === '1' || req.body?.notify === true;
        const r = await recalculateAllRanks({ notify });
        res.json({ ok: true, notify, ...r });
    } catch (err) {
        console.error('recalculateAllRanks', err);
        res.status(500).json({ message: 'Error al recalcular rangos' });
    }
};

// GET /admin/ranks
// Panel de rangos: distribución por nivel + listado de afiliadas con su rango,
// lo facturado y lo que les falta para el siguiente.
const getRanksOverview = async (req, res) => {
    try {
        // Total facturado por afiliada (no anuladas), de una sola pasada.
        const agg = await Commission.aggregate([
            { $match: { status: { $ne: 'voided' } } },
            { $group: { _id: '$affiliate', totalUSD: { $sum: '$commissionAmountUSD' }, comisiones: { $sum: 1 } } }
        ]);

        const ids = agg.map(a => a._id).filter(Boolean);
        const users = await User.find({ _id: { $in: ids } })
            .select('username email avatar role partnerLevel rankCode rankLevel rankReachedAt')
            .lean();
        const userMap = new Map(users.map(u => [String(u._id), u]));

        const items = [];
        for (const a of agg) {
            const u = userMap.get(String(a._id));
            if (!u) continue;   // afiliada borrada: sus comisiones quedan huérfanas

            const totalUSD = +(a.totalUSD || 0).toFixed(2);
            const guardado = byCode[u.rankCode] || null;
            const progreso = rankProgress(totalUSD);
            const leToca = progreso.current;

            items.push({
                _id: u._id,
                username: u.username,
                email: u.email,
                avatar: u.avatar,
                role: u.role,
                partnerLevel: u.partnerLevel || 1,
                totalUSD,
                comisiones: a.comisiones,
                rank: guardado
                    ? { code: guardado.code, level: guardado.level, title: guardado.title,
                        gradient: guardado.gradient, accent: guardado.accent, text: guardado.text }
                    : null,
                rankReachedAt: u.rankReachedAt || null,
                // Si el guardado se quedó por debajo del que le toca, hay que recalcular.
                pendiente: (guardado?.level ?? 0) < leToca.level
                    ? { code: leToca.code, level: leToca.level, title: leToca.title }
                    : null,
                next: progreso.next
                    ? { code: progreso.next.code, title: progreso.next.title, minUSD: progreso.next.minUSD }
                    : null,
                percent: progreso.percent,
                remainingUSD: progreso.remainingUSD
            });
        }

        items.sort((a, b) => b.totalUSD - a.totalUSD);

        // Distribución: se cuenta por el rango GUARDADO, que es el que ellas ven.
        const distribucion = ranks.map(r => ({
            code: r.code,
            level: r.level,
            title: r.title,
            minUSD: r.minUSD,
            gradient: r.gradient,
            accent: r.accent,
            count: items.filter(i => (i.rank?.level ?? 0) === r.level).length
        }));

        res.json({
            items,
            distribucion,
            totales: {
                afiliadas: items.length,
                porRecalcular: items.filter(i => i.pendiente).length,
                facturadoUSD: +items.reduce((n, i) => n + i.totalUSD, 0).toFixed(2)
            }
        });
    } catch (err) {
        console.error('getRanksOverview', err);
        res.status(500).json({ message: 'Error al cargar los rangos' });
    }
};

module.exports = { getMyEngagement, recalculateAllAchievements, recalculateAllRanksEndpoint, getRanksOverview };
