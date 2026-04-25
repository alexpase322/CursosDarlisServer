// Crea o actualiza el endpoint de webhook en Stripe con todos los eventos
// que la app maneja. Si ya existe un endpoint apuntando a la misma URL,
// actualiza su lista de eventos (no duplica).
//
// Uso:
//   node server/scripts/setupStripeWebhook.js https://tu-backend.com
//   o bien:
//   BACKEND_URL=https://tu-backend.com node server/scripts/setupStripeWebhook.js
//
// Tras crear uno nuevo imprime el `Signing secret`. Cópialo a STRIPE_WEBHOOK_SECRET
// en tu .env del backend (sólo se muestra una vez).

require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const REQUIRED_EVENTS = [
    'checkout.session.completed',
    'invoice.payment_succeeded',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'charge.refunded'
];

(async () => {
    if (!process.env.STRIPE_SECRET_KEY) {
        console.error('Falta STRIPE_SECRET_KEY en .env');
        process.exit(1);
    }

    const baseUrl = (process.argv[2] || process.env.BACKEND_URL || '').replace(/\/+$/, '');
    if (!baseUrl) {
        console.error('Pásame la URL pública del backend. Ej:');
        console.error('  node server/scripts/setupStripeWebhook.js https://tu-backend.com');
        process.exit(1);
    }
    const url = `${baseUrl}/payment/webhook`;

    console.log(`Buscando endpoint para ${url} ...`);
    const list = await stripe.webhookEndpoints.list({ limit: 100 });
    const existing = list.data.find(w => w.url === url);

    if (existing) {
        const current = new Set(existing.enabled_events || []);
        const wanted = new Set(REQUIRED_EVENTS);
        const merged = Array.from(new Set([...current, ...wanted]));
        const missing = REQUIRED_EVENTS.filter(e => !current.has(e));

        if (missing.length === 0) {
            console.log(`✓ Endpoint ya existe (${existing.id}) y tiene todos los eventos requeridos.`);
            console.log('  Eventos:', existing.enabled_events.join(', '));
            return;
        }

        console.log(`Endpoint existe (${existing.id}). Faltan: ${missing.join(', ')}`);
        const updated = await stripe.webhookEndpoints.update(existing.id, {
            enabled_events: merged
        });
        console.log(`✓ Endpoint actualizado. Eventos ahora:`);
        console.log('  ' + updated.enabled_events.join(', '));
        console.log('\nNOTA: el signing secret no cambia. Mantén el STRIPE_WEBHOOK_SECRET actual.');
        return;
    }

    console.log('No existe endpoint, creándolo...');
    const created = await stripe.webhookEndpoints.create({
        url,
        enabled_events: REQUIRED_EVENTS,
        description: 'CursosDarlis backend - auto-creado'
    });

    console.log(`✓ Endpoint creado: ${created.id}`);
    console.log(`  URL: ${created.url}`);
    console.log(`  Eventos: ${created.enabled_events.join(', ')}`);
    console.log('\n=========================================================');
    console.log('COPIA ESTE SECRET A STRIPE_WEBHOOK_SECRET EN TU .env:');
    console.log(`  ${created.secret}`);
    console.log('=========================================================');
    console.log('Después reinicia el backend.');
})().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
