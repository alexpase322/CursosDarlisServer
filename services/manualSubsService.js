// Mantenimiento del estado de suscripciones MANUALES.
// Las subs de Stripe ya se actualizan solas (webhook). Las manuales no tienen
// ningún sistema externo que las "expire", así que las revisamos a diario.
//
// Regla:
//   - manual + status:active   y  currentPeriodEnd < ahora  →  past_due
//   - manual + status:past_due y  currentPeriodEnd < (ahora - 30 días) → canceled
//
// Esto deja la sub visible como "atrasada" un mes después del vencimiento (para
// que el admin pueda pedir el pago) y la cancela después si no se renueva.

const User = require('../models/User');

const GRACE_PERIOD_DAYS = 30;

async function checkExpiredManualSubs({ log = console.log } = {}) {
    const now = new Date();
    const graceCutoff = new Date(now.getTime() - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

    // Active → past_due
    const toPastDue = await User.updateMany(
        {
            'subscription.id': { $regex: '^manual_' },
            'subscription.status': 'active',
            'subscription.currentPeriodEnd': { $lt: now }
        },
        { $set: { 'subscription.status': 'past_due' } }
    );

    // past_due (vencida hace >30 días) → canceled
    const toCanceled = await User.updateMany(
        {
            'subscription.id': { $regex: '^manual_' },
            'subscription.status': 'past_due',
            'subscription.currentPeriodEnd': { $lt: graceCutoff }
        },
        { $set: { 'subscription.status': 'canceled' } }
    );

    const stats = {
        movedToPastDue: toPastDue.modifiedCount || 0,
        movedToCanceled: toCanceled.modifiedCount || 0
    };

    if (stats.movedToPastDue > 0 || stats.movedToCanceled > 0) {
        log(`[manual-subs] active→past_due: ${stats.movedToPastDue} · past_due→canceled: ${stats.movedToCanceled}`);
    }

    return stats;
}

module.exports = { checkExpiredManualSubs, GRACE_PERIOD_DAYS };
