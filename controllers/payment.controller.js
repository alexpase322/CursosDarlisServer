const User = require('../models/User');
const Payment = require('../models/Payment');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const {
    recordCommissionFromInvoice,
    recordCommissionForOneTimeSale,
    onReferredSubscriptionActivated,
    onReferredSubscriptionCanceled,
    voidCommissionByInvoiceId
} = require('../services/commissionService');
const { inferPlan, planFromStripePriceId, isOneTimePlan, legacyPlans, prices } = require('../config/affiliateConfig');
const { resolveReferralCode, ensureReferralCode } = require('../services/referralService');
const { sendInvitation } = require('../services/invitationService');
const { sendToAdmins } = require('../services/pushService');
const { getQuarterlyPromo } = require('../services/promoService');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// 1. Crear Sesión de Checkout (Redirige al usuario a Stripe)
const createCheckoutSession = async (req, res) => {
    const { priceId, email, referralCode } = req.body;

    try {
        if (!priceId || typeof priceId !== 'string') {
            return res.status(400).json({ message: 'Plan inválido' });
        }

        let customerId = null;
        let userIdForMetadata = null;
        const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

        if (normalizedEmail) {
            const user = await User.findOne({ email: normalizedEmail });
            if (user) {
                userIdForMetadata = user._id.toString();
                if (user.subscription?.customerId) {
                    customerId = user.subscription.customerId;
                }
            }
        }

        // Resolver el código de afiliada (si vino del link /r/<code>) para
        // dejarlo en la metadata y atribuir la venta en el webhook.
        let affiliateId = null;
        let affiliateCode = null;
        if (referralCode && typeof referralCode === 'string') {
            const affiliate = await resolveReferralCode(referralCode);
            if (affiliate) {
                affiliateId = String(affiliate._id);
                affiliateCode = affiliate.referralCode;
            }
        }

        // ¿Es un plan de pago único (lifetime) o una suscripción?
        const planFromPrice = planFromStripePriceId(priceId);

        // Bloquear planes descontinuados (trimestral/anual): ya no se venden.
        // Las alumnas que ya los tienen siguen renovando sin problema.
        if (planFromPrice && legacyPlans.includes(planFromPrice)) {
            return res.status(410).json({
                message: 'Este plan ya no está disponible. Elige el plan mensual o el pago único.'
            });
        }

        const oneTime = isOneTimePlan(planFromPrice);

        const metadata = {};
        if (userIdForMetadata) metadata.userId = userIdForMetadata;
        if (affiliateId) metadata.affiliateId = affiliateId;
        if (affiliateCode) metadata.referralCode = affiliateCode;
        if (planFromPrice) metadata.plan = planFromPrice;

        const sessionConfig = {
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            mode: oneTime ? 'payment' : 'subscription',
            success_url: `${process.env.FRONTEND_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}/#planes`,
            metadata
        };

        // La metadata también se copia a la suscripción (solo aplica en mode:'subscription').
        if (!oneTime && Object.keys(metadata).length > 0) {
            sessionConfig.subscription_data = { metadata };
        }

        if (customerId) {
            sessionConfig.customer = customerId;
        } else if (normalizedEmail) {
            sessionConfig.customer_email = normalizedEmail;
        }

        const session = await stripe.checkout.sessions.create(sessionConfig);
        res.json({ url: session.url });

    } catch (error) {
        console.error('createCheckoutSession', error);
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

            case 'invoice.payment_failed':
                await handleInvoicePaymentFailed(event.data.object);
                break;

            case 'customer.subscription.updated':
                await handleSubscriptionUpdated(event.data.object);
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

// Compra de PAGO ÚNICO (plan lifetime $247).
// Otorga: acceso de por vida + activación automática como Partner (N2) + su link
// de afiliada, y paga la comisión fija ($197) a quien la refirió.
const handleOneTimePurchase = async (session) => {
    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const meta = session.metadata || {};

    // 1) Resolver email de la compradora
    let email = (session.customer_email || session.customer_details?.email || '').toLowerCase().trim();
    if (!email && session.customer) {
        try {
            const c = await stripe.customers.retrieve(session.customer);
            email = c && !c.deleted && c.email ? c.email.toLowerCase().trim() : '';
        } catch { /* noop */ }
    }
    if (!email) {
        console.warn('[one-time] sin email, no se puede procesar la compra', session.id);
        return;
    }

    const amountUSD = session.amount_total != null ? session.amount_total / 100 : prices.lifetime;
    const plan = meta.plan || 'lifetime';
    const paidAt = new Date();

    // 2) Buscar o crear la usuaria (auto-invitación crea la cuenta + manda el correo)
    let user = meta.userId ? await User.findById(meta.userId) : null;
    if (!user) {
        user = await User.findOne({ email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' } });
    }
    if (!user) {
        try {
            const r = await sendInvitation({ email, role: 'user', mode: 'auto' });
            if (r.userId) user = await User.findById(r.userId);
            console.log(`[one-time] auto-invite ${email} → ${r.reason}`);
        } catch (err) {
            console.error('[one-time] error creando usuaria:', err.message);
        }
    }
    if (!user) {
        console.warn('[one-time] no se pudo resolver/crear la usuaria', email);
        return;
    }

    // 3) Atribuir la afiliada que la refirió (solo si aún no tiene una)
    if (!user.referredBy && meta.affiliateId) {
        try {
            const affiliate = await User.findById(meta.affiliateId).select('_id partnerLevel');
            if (affiliate && String(affiliate._id) !== String(user._id) && affiliate.partnerLevel >= 2) {
                user.referredBy = affiliate._id;
            }
        } catch { /* noop */ }
    }

    // 4) Otorgar acceso vitalicio + activarla como Partner N2
    const wasPartner = (user.partnerLevel || 1) >= 2;
    user.lifetimeAccess = true;
    user.lifetimeGrantedAt = user.lifetimeGrantedAt || paidAt;
    user.subscription = {
        ...(user.subscription || {}),
        id: user.subscription?.id || `lifetime_${user._id}`,
        customerId: session.customer || user.subscription?.customerId,
        status: 'active',
        plan: 'lifetime',
        currentPeriodEnd: null   // nunca vence
    };
    if (!wasPartner) {
        user.partnerLevel = 2;
        user.partnerActivatedAt = paidAt;
    }
    await user.save();

    // 5) Generar su link de afiliada
    try { await ensureReferralCode(user); } catch (e) { console.error('[one-time] referralCode', e.message); }

    // 6) Registrar el pago (idempotente por el id del checkout session)
    const externalId = session.payment_intent || session.id;
    try {
        await Payment.updateOne(
            { stripeInvoiceId: externalId },
            { $setOnInsert: {
                email,
                stripeCustomerId: session.customer || null,
                stripeInvoiceId: externalId,
                stripeSubscriptionId: null,
                plan,
                amountUSD,
                status: 'paid',
                paidAt
            } },
            { upsert: true }
        );
    } catch (err) {
        if (err.code !== 11000) console.error('[one-time] Payment', err.message);
    }

    // 7) Comisión fija para la afiliada que la refirió
    if (user.referredBy) {
        try {
            const c = await recordCommissionForOneTimeSale({
                referredUser: user,
                affiliateId: user.referredBy,
                plan,
                grossAmountUSD: amountUSD,
                externalId,
                paidAt
            });
            if (c) console.log(`[one-time] comisión $${c.commissionAmountUSD} → afiliada ${user.referredBy}`);
        } catch (err) {
            console.error('[one-time] comisión:', err.message);
        }
        // Contar como referida activa
        try { await onReferredSubscriptionActivated(user); } catch { /* noop */ }
    }

    // 8) Avisar a los admins
    notifyAdminsOfNewSubscription(user, {
        amount_paid: session.amount_total,
        customer_email: email
    }).catch(e => console.error('[one-time] notifyAdmins', e.message));

    console.log(`[one-time] ${email} → acceso vitalicio + Partner N2 · $${amountUSD}`);
};

const handleCheckoutSuccess = async (session) => {
    const userId = session.metadata && session.metadata.userId;
    const subscriptionId = session.subscription;

    // Pago único (plan lifetime $247): no crea suscripción en Stripe.
    if (!subscriptionId || session.mode === 'payment') {
        if (session.mode === 'payment') {
            await handleOneTimePurchase(session);
        }
        return;
    }

    let subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const subItem = subscription.items.data[0];
    const priceId = subItem?.price?.id;
    const subAmountUSD = subItem?.price?.unit_amount != null ? subItem.price.unit_amount / 100 : null;
    const plan = inferPlan({ priceId, lineItem: subItem, amountUSD: subAmountUSD });

    // ─── Aplicar promo trimestral si está activa ───
    // Mecánica: el cliente paga el cobro normal en el checkout. Después extendemos
    // el currentPeriodEnd del sub en Stripe N meses (vía `trial_end`) para que el
    // próximo cobro caiga N meses más tarde. Después de eso el ciclo trimestral
    // se reanuda normalmente.
    let promoApplied = null;
    try {
        if (plan === 'quarterly') {
            const promo = await getQuarterlyPromo();
            if (promo.enabled && promo.extraMonths > 0) {
                const currentEndMs = subscription.current_period_end * 1000;
                const newEnd = new Date(currentEndMs);
                newEnd.setMonth(newEnd.getMonth() + promo.extraMonths);
                const newEndUnix = Math.floor(newEnd.getTime() / 1000);

                subscription = await stripe.subscriptions.update(subscriptionId, {
                    trial_end: newEndUnix,
                    proration_behavior: 'none'
                });
                promoApplied = {
                    extraMonths: promo.extraMonths,
                    newCurrentPeriodEnd: newEnd
                };
                console.log(`[checkout] PROMO aplicada · +${promo.extraMonths} mes(es) a sub ${subscriptionId}`);
            }
        }
    } catch (promoErr) {
        console.error('[checkout promo] error:', promoErr.message);
    }

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
        currentPeriodEnd: promoApplied
            ? promoApplied.newCurrentPeriodEnd
            : new Date(subscription.current_period_end * 1000)
    };
    await user.save();

    if (wasInactive && (subscription.status === 'active' || subscription.status === 'trialing')) {
        await onReferredSubscriptionActivated(user);
    }

    console.log(`[checkout] Usuario ${user._id} suscrito (${plan || 'plan?'}). Estado: ${subscription.status}${promoApplied ? ` · +${promoApplied.extraMonths}m promo` : ''}`);
};

const handleInvoicePaymentSucceeded = async (invoice) => {
    const customerId = invoice.customer;
    const subscriptionId = getSubscriptionIdFromInvoice(invoice);
    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Resolver email del invoice (lo necesitamos sí o sí para auto-invitar).
    let email = (invoice.customer_email || '').toLowerCase().trim();
    if (!email && customerId) {
        try {
            const c = await stripe.customers.retrieve(customerId);
            email = c && !c.deleted && c.email ? c.email.toLowerCase().trim() : '';
        } catch { /* noop */ }
    }

    // Buscar usuario por (1) customerId, (2) subscriptionId, (3) email.
    let user = await User.findOne({ 'subscription.customerId': customerId });
    if (!user && subscriptionId) {
        user = await User.findOne({ 'subscription.id': subscriptionId });
    }
    if (!user && email) {
        user = await User.findOne({ email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' } });
    }

    // Si NO existe el User aún, lo creamos vía auto-invite ANTES de actualizar
    // subscription. Sin esto el correo dispara la creación tarde y se queda sin sub.
    if (!user && email) {
        try {
            const r = await sendInvitation({ email, role: 'user', mode: 'auto' });
            console.log(`[auto-invite] ${email} → ${r.reason}`);
            if (r.userId) {
                user = await User.findById(r.userId);
            }
        } catch (err) {
            console.error('[auto-invite] error:', err.message);
        }
    }

    // Ahora sí, asignar/actualizar la subscription en el User.
    if (user) {
        const lineItem = invoice.lines && invoice.lines.data && invoice.lines.data[0];
        const periodEnd = lineItem && lineItem.period && lineItem.period.end
            ? new Date(lineItem.period.end * 1000) : null;
        const priceId = lineItem && lineItem.price && lineItem.price.id;
        const amountUSD = invoice.amount_paid != null ? invoice.amount_paid / 100 : 0;
        const plan = inferPlan({ priceId, lineItem, amountUSD });

        user.subscription = {
            ...(user.subscription || {}),
            id: subscriptionId || user.subscription?.id,
            customerId: customerId || user.subscription?.customerId,
            status: 'active',
            plan: plan || user.subscription?.plan,
            currentPeriodEnd: periodEnd || user.subscription?.currentPeriodEnd
        };
        await user.save();
    } else {
        console.warn(`[invoice.payment_succeeded] usuario no encontrado y sin email (customer=${customerId}, sub=${subscriptionId})`);
    }

    // billing_reason puede ser 'subscription_create' (primer cobro) o 'subscription_cycle' (renovación).
    // En ambos casos generamos commission si la referida tiene referredBy.
    await recordCommissionFromInvoice(invoice);

    // Registrar el pago en la tabla Payment (ticket de acceso para futuras invitaciones).
    await registerPaymentFromInvoice(invoice, user);

    // Auto-invite también para renovaciones (idempotente: no spammea si ya se envió).
    let isFirstPayment = false;
    if (email && user && !user.invitationSentAt) {
        isFirstPayment = true;
        try {
            const r = await sendInvitation({ email, role: 'user', mode: 'auto' });
            console.log(`[auto-invite] ${email} → ${r.reason}`);
        } catch (err) {
            console.error('[auto-invite] error:', err.message);
        }
    } else {
        // Detectar si es la PRIMERA invoice de esta suscripción (subscription_create)
        // para notificar admins solo en suscripciones nuevas (no renovaciones).
        isFirstPayment = invoice.billing_reason === 'subscription_create';
    }

    if (isFirstPayment) {
        notifyAdminsOfNewSubscription(user, invoice).catch(e =>
            console.error('[notifyAdmins newSub]', e.message)
        );
    }
};

async function notifyAdminsOfNewSubscription(user, invoice) {
    const userName = user?.username || invoice.customer_email || 'Nueva alumna';
    const userEmail = user?.email || invoice.customer_email || '';
    const amount = invoice.amount_paid != null ? (invoice.amount_paid / 100) : 0;

    // Push a todos los admins.
    try {
        await sendToAdmins({
            title: '🎉 Nueva suscripción',
            body: `${userName} se suscribió por $${amount.toFixed(2)}`,
            url: '/admin/suscripciones',
            tag: 'new-sub'
        });
    } catch (e) { /* noop */ }

    // Email a admins.
    if (!process.env.RESEND_API_KEY) return;
    try {
        const admins = await User.find({ role: 'admin' }).select('email').lean();
        const emails = admins.map(a => a.email).filter(Boolean);
        if (!emails.length) return;
        await resend.emails.send({
            from: 'Arquitecta <soporte@arquitectadetupropioexito.com>',
            to: emails,
            subject: `🎉 Nueva alumna suscrita: ${userName}`,
            html: `
              <div style="font-family:'Helvetica Neue',Arial,sans-serif;background:#F7F2EF;padding:32px 16px;color:#1B3854;">
                <table width="100%" style="max-width:520px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 24px rgba(27,56,84,0.08);">
                  <tr><td style="background:linear-gradient(135deg,#1B3854 0%,#0d1f30 100%);padding:32px;text-align:center;color:#fff;">
                    <h1 style="margin:0;font-size:24px;">🎉 Una arquitecta más</h1>
                    <p style="margin:8px 0 0;font-size:14px;opacity:0.95;">Acaba de entrar una alumna nueva.</p>
                  </td></tr>
                  <tr><td style="padding:28px;">
                    <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Alumna</p>
                    <p style="margin:0 0 16px;font-size:18px;font-weight:700;">${userName}</p>
                    <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Email</p>
                    <p style="margin:0 0 16px;font-size:14px;color:#475569;">${userEmail}</p>
                    <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Monto</p>
                    <p style="margin:0;font-size:24px;font-weight:700;color:#10b981;">$${amount.toFixed(2)}</p>
                  </td></tr>
                  <tr><td style="padding:0 28px 28px;text-align:center;">
                    <a href="${process.env.FRONTEND_URL || 'https://arquitectadetupropioexito.com'}/admin/suscripciones"
                       style="display:inline-block;padding:12px 28px;background:#905361;color:#fff;font-weight:700;text-decoration:none;border-radius:12px;">
                      Ver en panel admin
                    </a>
                  </td></tr>
                </table>
              </div>`
        });
    } catch (e) { console.error('[email admin newSub]', e.message); }
}

// Lee el subscriptionId de un invoice de Stripe, cubriendo API antigua y nueva.
// API ≤ 2024: invoice.subscription
// API ≥ 2024-09: invoice.parent.subscription_details.subscription o
//                invoice.lines.data[*].subscription / parent.subscription_item_details.subscription
const getSubscriptionIdFromInvoice = (invoice) => {
    if (!invoice) return null;
    if (invoice.subscription) return invoice.subscription;
    if (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription) {
        return invoice.parent.subscription_details.subscription;
    }
    const lines = invoice.lines && invoice.lines.data ? invoice.lines.data : [];
    for (const li of lines) {
        if (li.subscription) return li.subscription;
        if (li.parent && li.parent.subscription_item_details && li.parent.subscription_item_details.subscription) {
            return li.parent.subscription_item_details.subscription;
        }
    }
    return null;
};

// Crea un Payment idempotente desde un invoice de Stripe.
const registerPaymentFromInvoice = async (invoice, user) => {
    if (!invoice || !invoice.id) return;
    try {
        const lineItem = invoice.lines && invoice.lines.data && invoice.lines.data[0];
        const priceId = lineItem && lineItem.price && lineItem.price.id;
        const amountUSD = invoice.amount_paid != null ? invoice.amount_paid / 100 : 0;
        const plan = inferPlan({ priceId, lineItem, amountUSD });
        const subscriptionId = getSubscriptionIdFromInvoice(invoice);

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
                    stripeSubscriptionId: subscriptionId,
                    plan: plan || 'monthly',
                    amountUSD,
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

// Registra un intento de cobro fallido. Idempotente por stripeInvoiceId:
// si ya existe el Payment, actualiza failedAt / attemptCount / failureReason
// y lo deja en status 'failed' (a menos que ya esté 'paid' por un reintento exitoso).
const handleInvoicePaymentFailed = async (invoice) => {
    if (!invoice || !invoice.id) return;
    try {
        const subscriptionId = getSubscriptionIdFromInvoice(invoice);
        const customerId = invoice.customer;

        // Resolver email
        let email = (invoice.customer_email || '').toLowerCase().trim();
        if (!email && customerId) {
            try {
                const c = await stripe.customers.retrieve(customerId);
                email = c && !c.deleted && c.email ? c.email.toLowerCase().trim() : '';
            } catch { /* noop */ }
        }
        if (!email) {
            console.warn(`[invoice.payment_failed] sin email (invoice=${invoice.id}); skip`);
            return;
        }

        const lineItem = invoice.lines && invoice.lines.data && invoice.lines.data[0];
        const priceId = lineItem && lineItem.price && lineItem.price.id;
        const amountUSD = invoice.amount_due != null ? invoice.amount_due / 100
            : (invoice.amount_paid != null ? invoice.amount_paid / 100 : 0);
        const plan = inferPlan({ priceId, lineItem, amountUSD });

        const failedAt = new Date();
        const nextAttemptAt = invoice.next_payment_attempt
            ? new Date(invoice.next_payment_attempt * 1000) : null;
        const failureReason = invoice.last_finalization_error?.message
            || invoice.last_payment_error?.message
            || (lineItem && lineItem.description)
            || 'Pago rechazado';

        const existing = await Payment.findOne({ stripeInvoiceId: invoice.id });

        if (!existing) {
            await Payment.create({
                email,
                stripeCustomerId: customerId || null,
                stripeInvoiceId: invoice.id,
                stripeSubscriptionId: subscriptionId,
                plan: plan || 'monthly',
                amountUSD,
                status: 'failed',
                paidAt: failedAt, // usamos failedAt también como ancla temporal
                failedAt,
                failureReason,
                attemptCount: invoice.attempt_count || 1,
                nextAttemptAt
            });
        } else if (existing.status !== 'paid') {
            // No pisamos un pago exitoso (caso: fallo en intento N, éxito en N+1).
            await Payment.updateOne(
                { _id: existing._id },
                { $set: {
                    status: 'failed',
                    failedAt,
                    failureReason,
                    attemptCount: invoice.attempt_count || (existing.attemptCount || 0) + 1,
                    nextAttemptAt,
                    stripeSubscriptionId: subscriptionId || existing.stripeSubscriptionId,
                    stripeCustomerId: customerId || existing.stripeCustomerId
                } }
            );
        }

        // Reflejar en User.subscription si existe (status pasa a past_due / unpaid).
        const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const user = await User.findOne({
            $or: [
                { 'subscription.customerId': customerId },
                { 'subscription.id': subscriptionId },
                { email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' } }
            ]
        });
        if (user && user.subscription) {
            // Stripe no nos da el status en este evento; lo más exacto: leerlo de la sub.
            try {
                if (subscriptionId) {
                    const sub = await stripe.subscriptions.retrieve(subscriptionId);
                    user.subscription.status = sub.status; // 'past_due' | 'unpaid' | 'canceled' | etc.
                    await user.save();
                }
            } catch { /* noop */ }
        }
    } catch (err) {
        console.error('[handleInvoicePaymentFailed]', err);
    }
};

const handleSubscriptionUpdated = async (subscription) => {
    let user = await User.findOne({ 'subscription.id': subscription.id });
    if (!user && subscription.customer) {
        user = await User.findOne({ 'subscription.customerId': subscription.customer });
    }
    if (!user) {
        console.warn(`[customer.subscription.updated] usuario no encontrado (sub=${subscription.id})`);
        return;
    }
    const subItem = subscription.items && subscription.items.data && subscription.items.data[0];
    const priceId = subItem?.price?.id;
    const subAmountUSD = subItem?.price?.unit_amount != null ? subItem.price.unit_amount / 100 : null;
    const plan = inferPlan({ priceId, lineItem: subItem, amountUSD: subAmountUSD });

    user.subscription = {
        ...(user.subscription || {}),
        id: subscription.id,
        customerId: subscription.customer,
        status: subscription.status,
        plan: plan || user.subscription?.plan,
        currentPeriodEnd: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000)
            : user.subscription?.currentPeriodEnd
    };
    await user.save();

    if (subscription.status === 'canceled' || subscription.cancel_at_period_end) {
        // No es delete real, solo aviso de fin de ciclo. No tocamos counters todavía.
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
