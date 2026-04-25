const { syncStripePayments } = require('../services/stripeSyncService');

// POST /admin/stripe/sync-payments
// Sincroniza pagos y suscripciones de Stripe con la BD.
// Solo procesa emails de usuarios existentes (rol != admin).
const syncPayments = async (req, res) => {
    const startedAt = Date.now();
    try {
        const { dryRun, plan, all } = req.body || {};
        const counters = await syncStripePayments({
            dryRun: !!dryRun,
            planFilter: plan || null,
            onlyRegistered: !all,
            log: (m) => console.log('[stripe-sync]', m)
        });
        const elapsedMs = Date.now() - startedAt;
        res.json({ ok: true, elapsedMs, counters });
    } catch (err) {
        console.error('[stripe-sync] error', err);
        res.status(500).json({ ok: false, message: err.message || 'Error sincronizando' });
    }
};

module.exports = { syncPayments };
