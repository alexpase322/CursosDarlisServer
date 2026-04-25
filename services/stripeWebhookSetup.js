// Asegura que el webhook endpoint exista en Stripe con todos los eventos
// que la app maneja. Se ejecuta al arranque del servidor.
//
// - Si ya existe un endpoint apuntando a `<BACKEND_URL>/payment/webhook`,
//   le añade los eventos faltantes (no duplica, no rota el secret).
// - Si no existe, lo crea con los 5 eventos y loguea el signing secret.
//
// Variables que lee:
//   STRIPE_SECRET_KEY      (obligatoria; si falta, no hace nada y avisa)
//   BACKEND_URL            (URL pública del backend, ej. https://api.tudominio.com)
//   STRIPE_WEBHOOK_DISABLE_AUTOSETUP=1  → desactiva esta auto-configuración

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const REQUIRED_EVENTS = [
    'checkout.session.completed',
    'invoice.payment_succeeded',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'charge.refunded'
];

async function ensureStripeWebhook() {
    if (process.env.STRIPE_WEBHOOK_DISABLE_AUTOSETUP === '1') {
        return;
    }
    if (!process.env.STRIPE_SECRET_KEY) {
        console.warn('[stripe-webhook-setup] STRIPE_SECRET_KEY ausente, skip.');
        return;
    }

    const baseUrl = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
    if (!baseUrl) {
        console.warn('[stripe-webhook-setup] BACKEND_URL ausente, skip. Define BACKEND_URL=https://tu-backend.com en .env para auto-registrar el webhook.');
        return;
    }
    if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(baseUrl)) {
        console.warn(`[stripe-webhook-setup] BACKEND_URL=${baseUrl} es local; Stripe no acepta endpoints en localhost. Skip.`);
        return;
    }

    const url = `${baseUrl}/payment/webhook`;

    try {
        const list = await stripe.webhookEndpoints.list({ limit: 100 });
        const existing = list.data.find(w => w.url === url);

        if (existing) {
            const current = new Set(existing.enabled_events || []);
            const missing = REQUIRED_EVENTS.filter(e => !current.has(e));
            if (missing.length === 0) {
                console.log(`[stripe-webhook-setup] OK: endpoint ${existing.id} ya tiene los ${REQUIRED_EVENTS.length} eventos requeridos.`);
                return;
            }
            const merged = Array.from(new Set([...current, ...REQUIRED_EVENTS]));
            const updated = await stripe.webhookEndpoints.update(existing.id, { enabled_events: merged });
            console.log(`[stripe-webhook-setup] Actualizado ${updated.id}. Eventos añadidos: ${missing.join(', ')}`);
            return;
        }

        const created = await stripe.webhookEndpoints.create({
            url,
            enabled_events: REQUIRED_EVENTS,
            description: 'CursosDarlis backend (auto-registrado al arranque)'
        });

        console.log('[stripe-webhook-setup] ════════════════════════════════════════════════');
        console.log(`[stripe-webhook-setup] Endpoint creado: ${created.id}`);
        console.log(`[stripe-webhook-setup] URL: ${created.url}`);
        console.log(`[stripe-webhook-setup] Eventos: ${created.enabled_events.join(', ')}`);
        console.log('[stripe-webhook-setup] ');
        console.log('[stripe-webhook-setup] >>> COPIA ESTE SECRET A STRIPE_WEBHOOK_SECRET EN TU .env <<<');
        console.log(`[stripe-webhook-setup] ${created.secret}`);
        console.log('[stripe-webhook-setup] ');
        console.log('[stripe-webhook-setup] Después reinicia el backend para que valide la firma.');
        console.log('[stripe-webhook-setup] ════════════════════════════════════════════════');
    } catch (err) {
        console.error('[stripe-webhook-setup] error:', err.message);
    }
}

module.exports = { ensureStripeWebhook };
