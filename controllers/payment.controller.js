const User = require('../models/User');
const Payment = require('../models/Payment');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const {
    recordCommissionFromInvoice,
    onReferredSubscriptionActivated,
    onReferredSubscriptionCanceled,
    voidCommissionByInvoiceId
} = require('../services/commissionService');
const { planFromStripePriceId } = require('../config/affiliateConfig');

// 1. Crear Sesión de Checkout (Redirige al usuario a Stripe)
const createCheckoutSession = async (req, res) => {
    const { priceId, email } = req.body;

    try {
        let customerId = null;
        let userIdForMetadata = null;

        if (email) {
            const user = await User.findOne({ email });
            if (user) {
                userIdForMetadata = user._id.toString();
                if (user.subscription?.customerId) {
                    customerId = user.subscription.customerId;
                }
            }
        }

        const sessionConfig = {
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'subscription',
            success_url: `${process.env.FRONTEND_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}/#planes`,
            metadata: userIdForMetadata ? { userId: userIdForMetadata } : {},
            subscription_data: userIdForMetadata
                ? { metadata: { userId: userIdForMetadata } }
                : undefined
        };

        if (customerId) {
            sessionConfig.customer = customerId;
        } else {
            sessionConfig.customer_email = email;
        }

        const session = await stripe.checkout.sessions.create(sessionConfig);
        res.json({ url: session.url });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error al crear sesión de pago" });
    }
};

// 2. Webhook (Stripe le avisa a tu servidor que el pago pasó)
// NOTA: Esto requiere una configuración especial en el index.js (body raw)
const stripeWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.log(`⚠️  Webhook Error: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        switch (event.type) {
            case 'checkout.session.completed':
                await handleCheckoutSuccess(event.data.object);
                break;

            case 'invoice.payment_succeeded':
                await handleInvoicePaymentSucceeded(event.data.object);
                break;

            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(event.data.object);
                break;

            case 'charge.refunded':
                await handleChargeRefunded(event.data.object);
                break;

            default:
                console.log(`Evento no manejado: ${event.type}`);
        }
    } catch (err) {
        console.error('[stripeWebhook] error procesando evento', event.type, err);
    }

    res.send();
};

// --- Helpers ---

const handleCheckoutSuccess = async (session) => {
    const userId = session.metadata && session.metadata.userId;
    const subscriptionId = session.subscription;
    if (!subscriptionId) return;

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const priceId = subscription.items.data[0]?.price?.id;
    const plan = planFromStripePriceId(priceId);

    let user = null;
    if (userId) {
        user = await User.findById(userId);
    }
    if (!user && session.customer_email) {
        user = await User.findOne({ email: session.customer_email });
    }
    if (!user) {
        console.warn('[checkout.session.completed] usuario no encontrado');
        return;
    }

    const wasInactive = !user.subscription || user.subscription.status !== 'active';

    user.subscription = {
        id: subscriptionId,
        customerId: session.customer,
        status: subscription.status,
        plan: plan || user.subscription?.plan,
        currentPeriodEnd: new Date(subscription.current_period_end * 1000)
    };
    await user.save();

    if (wasInactive && subscription.status === 'active') {
        await onReferredSubscriptionActivated(user);
    }

    console.log(`[checkout] Usuario ${user._id} suscrito (${plan || 'plan?'}). Estado: ${subscription.status}`);
};

const handleInvoicePaymentSucceeded = async (invoice) => {
    const customerId = invoice.customer;
    const user = await User.findOne({ 'subscription.customerId': customerId });

    if (user) {
        const lineItem = invoice.lines && invoice.lines.data && invoice.lines.data[0];
        if (lineItem && lineItem.period) {
            user.subscription.currentPeriodEnd = new Date(lineItem.period.end * 1000);
        }
        user.subscription.status = 'active';
        await user.save();
    }

    // billing_reason puede ser 'subscription_create' (primer cobro) o 'subscription_cycle' (renovación).
    // En ambos casos generamos commission si la referida tiene referredBy.
    await recordCommissionFromInvoice(invoice);

    // Registrar el pago en la tabla Payment (ticket de acceso para futuras invitaciones).
    await registerPaymentFromInvoice(invoice, user);
};

// Crea un Payment idempotente desde un invoice de Stripe.
const registerPaymentFromInvoice = async (invoice, user) => {
    if (!invoice || !invoice.id) return;
    try {
        const lineItem = invoice.lines && invoice.lines.data && invoice.lines.data[0];
        const priceId = lineItem && lineItem.price && lineItem.price.id;
        const plan = planFromStripePriceId(priceId);

        let email = (invoice.customer_email || (user && user.email) || '').toLowerCase().trim();
        if (!email && invoice.customer) {
            try {
                const customer = await stripe.customers.retrieve(invoice.customer);
                email = (customer && customer.email ? customer.email : '').toLowerCase().trim();
            } catch (e) {
                /* noop */
            }
        }
        if (!email) {
            console.warn(`[payment] invoice ${invoice.id} sin email, no se registra Payment`);
            return;
        }

        await Payment.updateOne(
            { stripeInvoiceId: invoice.id },
            {
                $setOnInsert: {
                    email,
                    stripeCustomerId: invoice.customer || null,
                    stripeInvoiceId: invoice.id,
                    stripeSubscriptionId: invoice.subscription || null,
                    plan: plan || 'monthly',
                    amountUSD: invoice.amount_paid != null ? invoice.amount_paid / 100 : 0,
                    status: 'paid',
                    paidAt: invoice.status_transitions && invoice.status_transitions.paid_at
                        ? new Date(invoice.status_transitions.paid_at * 1000)
                        : new Date()
                }
            },
            { upsert: true }
        );
    } catch (err) {
        console.error('[registerPaymentFromInvoice]', err);
    }
};

const handleSubscriptionDeleted = async (subscription) => {
    const user = await User.findOne({ 'subscription.id': subscription.id });
    if (!user) return;
    user.subscription.status = subscription.status || 'canceled';
    await user.save();
    await onReferredSubscriptionCanceled(user);
};

const handleChargeRefunded = async (charge) => {
    const invoiceId = charge.invoice;
    if (!invoiceId) return;
    await voidCommissionByInvoiceId(invoiceId);
    await Payment.updateOne(
        { stripeInvoiceId: invoiceId },
        { $set: { status: 'refunded', refundedAt: new Date() } }
    );
};

// 3. Crear sesión del Customer Portal de Stripe
//    Permite al usuario actualizar método de pago, ver facturas y cancelar
//    su suscripción desde el portal hospedado por Stripe.
const createBillingPortalSession = async (req, res) => {
    try {
        let customerId = req.user?.subscription?.customerId;

        // Fallback: si todavía no tenemos customerId guardado pero existe en Stripe
        // (por ejemplo, suscripciones importadas vía sync), lo buscamos por email.
        if (!customerId && req.user?.email) {
            const list = await stripe.customers.list({ email: req.user.email, limit: 1 });
            if (list.data && list.data[0]) customerId = list.data[0].id;
        }

        if (!customerId) {
            return res.status(404).json({ message: 'No se encontró un cliente de Stripe asociado a tu cuenta.' });
        }

        const sessionConfig = {
            customer: customerId,
            return_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/profile`
        };
        if (process.env.STRIPE_BILLING_PORTAL_CONFIG_ID) {
            sessionConfig.configuration = process.env.STRIPE_BILLING_PORTAL_CONFIG_ID;
        }

        const session = await stripe.billingPortal.sessions.create(sessionConfig);
        res.json({ url: session.url });
    } catch (err) {
        console.error('[billingPortal]', err);
        res.status(500).json({ message: 'No se pudo abrir el portal de pagos.' });
    }
};

module.exports = { createCheckoutSession, stripeWebhook, createBillingPortalSession };
