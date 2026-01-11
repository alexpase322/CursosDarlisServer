const User = require('../models/User');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// 1. Crear Sesión de Checkout (Redirige al usuario a Stripe)
const createCheckoutSession = async (req, res) => {
    const { priceId, email } = req.body; // El email puede venir del front si el usuario estaba logueado

    try {
        let customerId = null;

        // 1. Si enviaron email (usuario logueado), buscamos si ya tiene customerId en BD
        if (email) {
            const user = await User.findOne({ email });
            if (user && user.subscription?.customerId) {
                customerId = user.subscription.customerId;
            }
        }

        // 2. Configurar sesión de Stripe
        const sessionConfig = {
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'subscription',
            success_url: `${process.env.FRONTEND_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}/#planes`,
        };

        // Si tenemos ID de cliente (usuario antiguo), lo usamos. 
        // Si no, Stripe pedirá el email y creará uno nuevo.
        if (customerId) {
            sessionConfig.customer = customerId;
        } else {
            // Forzar a Stripe a pedir email si no lo tenemos
            sessionConfig.customer_email = email; // Puede ser undefined (Stripe lo pedirá en su UI)
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
        // Verificar que la llamada viene de Stripe realmente
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.log(`⚠️  Webhook Error: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Manejar el evento
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            await handleCheckoutSuccess(session);
            break;
        
        case 'invoice.payment_succeeded':
            // Aquí se renueva la suscripción automáticamente cada mes/año
            const invoice = event.data.object;
            await handleSubscriptionRenewal(invoice);
            break;

        // Puedes manejar 'customer.subscription.deleted' para quitar acceso si cancelan
        default:
            console.log(`Evento no manejado: ${event.type}`);
    }

    res.send();
};

// Helpers para actualizar la BD
const handleCheckoutSuccess = async (session) => {
    const userId = session.metadata.userId;
    const subscriptionId = session.subscription;
    
    // Obtener detalles de la suscripción para saber cuándo expira
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    await User.findByIdAndUpdate(userId, {
        role: 'subscriber', // Le damos rol de suscriptor
        subscription: {
            id: subscriptionId,
            customerId: session.customer,
            status: 'active',
            currentPeriodEnd: new Date(subscription.current_period_end * 1000) // Stripe usa segundos, JS usa ms
        }
    });
    console.log(`Usuario ${userId} suscrito exitosamente.`);
};

const handleSubscriptionRenewal = async (invoice) => {
    const customerId = invoice.customer;
    // Buscar usuario por customerId
    const user = await User.findOne({ 'subscription.customerId': customerId });
    
    if(user) {
        user.subscription.currentPeriodEnd = new Date(invoice.lines.data[0].period.end * 1000);
        user.subscription.status = 'active';
        await user.save();
        console.log(`Suscripción renovada para ${user.username}`);
    }
};

module.exports = { createCheckoutSession, stripeWebhook };