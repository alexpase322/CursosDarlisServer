// Backfill de pagos históricos desde Stripe (CLI).
//
// Por defecto SOLO procesa invoices/suscripciones cuyo email pertenezca a un
// usuario existente en la BD con role != 'admin'. Pasa --all para no filtrar.
// Maneja también trials (subs en estado trialing/active/past_due sin invoice).
//
// Uso (desde /server):
//   node scripts/backfillStripePayments.js
//   node scripts/backfillStripePayments.js --all
//   node scripts/backfillStripePayments.js --dry-run
//   node scripts/backfillStripePayments.js --plan=monthly
//   node scripts/backfillStripePayments.js --since=2024-01-01

require('dotenv').config();
const mongoose = require('mongoose');
const { syncStripePayments } = require('../services/stripeSyncService');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, v] = a.replace(/^--/, '').split('=');
        return [k, v == null ? true : v];
    })
);

const dryRun = !!args['dry-run'];
const planFilter = args.plan || null;
const since = args.since ? Math.floor(new Date(args.since).getTime() / 1000) : null;
const onlyRegistered = !args.all;

(async () => {
    if (!process.env.MONGO_URI) {
        console.error('Falta MONGO_URI en .env');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URI);
    console.log('[backfill] conectado a Mongo');
    console.log('[backfill] modo:', dryRun ? 'DRY RUN' : 'ESCRITURA');
    console.log('[backfill] alcance:', onlyRegistered ? 'solo emails ya en BD (no admin)' : 'TODAS las invoices');
    if (planFilter) console.log('[backfill] filtro plan:', planFilter);
    if (since) console.log('[backfill] desde:', new Date(since * 1000).toISOString());

    try {
        const counters = await syncStripePayments({
            dryRun, planFilter, since, onlyRegistered,
            log: (m) => console.log('[backfill]', m)
        });
        console.log('\n[backfill] resumen:');
        console.log(`  invoices escaneadas:    ${counters.scanned}`);
        console.log(`  Payments insertados:    ${counters.inserted}`);
        console.log(`  ya existían:            ${counters.alreadyExisted}`);
        console.log(`  trials registrados:     ${counters.trialsRecorded}`);
        console.log(`  marcadas refunded:      ${counters.refunded}`);
        console.log(`  saltadas (sin email):   ${counters.skipped}`);
        console.log(`  saltadas (no en BD):    ${counters.skippedNotRegistered}`);
        console.log(`  users con sub act.:     ${counters.usersUpdated}`);
    } catch (err) {
        console.error('[backfill] error fatal', err);
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
    }
})();
