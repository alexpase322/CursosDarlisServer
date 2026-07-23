const Commission = require('../models/Commission');
const User = require('../models/User');
const { rates, prices, inferPlan, calculateCommission } = require('../config/affiliateConfig');
const { evaluateAutoPromotion } = require('./levelService');
const { sendToUser } = require('./pushService');
const { unlockAchievement, evaluateMilestones } = require('./engagementService');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// Lee el subscriptionId de un invoice de Stripe, cubriendo API antigua y nueva.
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

// Idempotente: si ya existe una Commission con el mismo stripeInvoiceId, no se duplica.
// Si referredUser no tiene referredBy → return null (la academia se queda con el cobro).
// Recorre los Payments paid de un usuario y crea Commission para los que aún
// no la tienen. Pensado para backfillear cuando la atribución de referidora
// se setea DESPUÉS del pago (caso típico: pago Stripe → webhook → User creado
// sin referredBy → alumna entra al setup-account y elige referidora).
// Procesa TANTO pagos de Stripe como pagos manuales (`manual_*`).
async function backfillCommissionsForUser(referredUser) {
    if (!referredUser || !referredUser.referredBy) return { created: 0, skipped: 0 };

    const Payment = require('../models/Payment');
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

    const email = (referredUser.email || '').toLowerCase().trim();
    if (!email) return { created: 0, skipped: 0 };

    const payments = await Payment.find({
        email,
        status: 'paid',
        amountUSD: { $gt: 0 },
        stripeInvoiceId: { $not: /^trial_/ } // trials no generan comisión (son $0)
    }).lean();

    let created = 0, skipped = 0;
    for (const p of payments) {
        const exists = await Commission.findOne({ stripeInvoiceId: p.stripeInvoiceId });
        if (exists) { skipped += 1; continue; }
        try {
            // Pago manual → flujo dedicado (no consultamos Stripe).
            if (p.stripeInvoiceId.startsWith('manual_')) {
                const c = await recordCommissionFromManualPayment(p);
                if (c) created += 1; else skipped += 1;
                continue;
            }
            // Pago Stripe normal → recuperar invoice y procesar.
            const invoice = await stripe.invoices.retrieve(p.stripeInvoiceId);
            const c = await recordCommissionFromInvoice(invoice);
            if (c) created += 1; else skipped += 1;
        } catch (err) {
            console.warn(`backfillCommissions invoice ${p.stripeInvoiceId}:`, err.message);
            skipped += 1;
        }
    }
    return { created, skipped };
}

// Crea Commission a partir de un Payment manual (transferencia, beacons, etc.).
// Idempotente por stripeInvoiceId (el ID sintético `manual_<userId>_<ts>`).
async function recordCommissionFromManualPayment(payment) {
    if (!payment || !payment.stripeInvoiceId) return null;
    if (!payment.stripeInvoiceId.startsWith('manual_')) return null;
    if (payment.status !== 'paid') return null;
    if (!payment.amountUSD || payment.amountUSD <= 0) return null;

    const existing = await Commission.findOne({ stripeInvoiceId: payment.stripeInvoiceId });
    if (existing) return existing;

    // Resolver al usuario referido por email (case-insensitive).
    const email = (payment.email || '').toLowerCase().trim();
    if (!email) return null;
    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const referredUser = await User.findOne({
        email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' }
    });
    if (!referredUser || !referredUser.referredBy) return null;

    const affiliate = await User.findById(referredUser.referredBy);
    if (!affiliate) return null;

    const plan = payment.plan || 'monthly';
    const calc = calculateCommission(plan, payment.amountUSD);
    if (!calc) {
        console.warn(`[commissions manual] plan ${plan} sin comisión definida; skip ${payment.stripeInvoiceId}`);
        return null;
    }
    const { amountUSD: commissionAmountUSD, percent: commissionPercent } = calc;

    // Si el pago fue por Beacons, Beacons ya le paga la comisión a la afiliada.
    // Aquí la registramos SOLO para trazabilidad: nace como 'paid' (externa),
    // no como 'available', para que no aparezca como algo que NOSOTROS debemos pagar.
    const isBeacons = payment.method === 'beacons';

    let commission;
    try {
        commission = await Commission.create({
            affiliate: affiliate._id,
            referredUser: referredUser._id,
            stripeInvoiceId: payment.stripeInvoiceId,
            stripeSubscriptionId: payment.stripeSubscriptionId || null,
            plan,
            grossAmountUSD: payment.amountUSD,
            commissionPercent,
            commissionAmountUSD,
            periodStart: payment.paidAt || null,
            periodEnd: null,
            status: isBeacons ? 'paid' : 'available',
            payoutSource: isBeacons ? 'beacons' : 'internal',
            paidAt: isBeacons ? (payment.paidAt || new Date()) : undefined,
            paidNote: isBeacons ? 'Pagada por Beacons (externo)' : ''
        });
    } catch (err) {
        if (err.code === 11000) return await Commission.findOne({ stripeInvoiceId: payment.stripeInvoiceId });
        throw err;
    }

    affiliate.referralStats = affiliate.referralStats || {};
    affiliate.referralStats.totalEarnedUSD = (affiliate.referralStats.totalEarnedUSD || 0) + commissionAmountUSD;
    if (isBeacons) {
        // Ya cobrada (por Beacons) → va directo a paidUSD, no a pendingUSD.
        affiliate.referralStats.paidUSD = (affiliate.referralStats.paidUSD || 0) + commissionAmountUSD;
    } else {
        affiliate.referralStats.pendingUSD = (affiliate.referralStats.pendingUSD || 0) + commissionAmountUSD;
    }
    await affiliate.save();

    await evaluateAutoPromotion(affiliate);

    // Notificar a la afiliada + milestones.
    notifyAffiliateOfCommission(affiliate, referredUser, commissionAmountUSD, plan).catch(e =>
        console.error('[notifyAffiliateOfCommission manual]', e.message)
    );
    evaluateMilestones(affiliate._id).catch(() => {});

    return commission;
}

async function recordCommissionFromInvoice(invoice, opts = {}) {
    if (!invoice || !invoice.id) return null;

    const existing = await Commission.findOne({ stripeInvoiceId: invoice.id });
    if (existing) return existing;

    const customerId = invoice.customer;
    let referredUser = opts.referredUser || await User.findOne({ 'subscription.customerId': customerId });
    // Fallback: buscar por email del invoice (caso webhook llega antes de que
    // User.subscription.customerId esté seteado).
    if (!referredUser) {
        const email = (invoice.customer_email || '').toLowerCase().trim();
        if (email) {
            const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            referredUser = await User.findOne({
                email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' }
            });
        }
    }
    if (!referredUser) return null;
    if (!referredUser.referredBy) return null;

    const affiliate = await User.findById(referredUser.referredBy);
    if (!affiliate) return null;

    const lineItem = invoice.lines && invoice.lines.data && invoice.lines.data[0];
    const priceId = lineItem && lineItem.price && lineItem.price.id;
    const grossAmountUSD = invoice.amount_paid != null
        ? invoice.amount_paid / 100
        : null;
    const plan = inferPlan({ priceId, lineItem, amountUSD: grossAmountUSD });
    if (!plan) {
        console.warn(`[commissions] no pude inferir plan para invoice ${invoice.id} (priceId=${priceId}, amount=${grossAmountUSD}); skip.`);
        return null;
    }

    const finalGross = grossAmountUSD != null ? grossAmountUSD : prices[plan];
    const calc = calculateCommission(plan, finalGross);
    if (!calc) {
        console.warn(`[commissions] plan ${plan} sin comisión definida; skip invoice ${invoice.id}`);
        return null;
    }
    const { amountUSD: commissionAmountUSD, percent: commissionPercent } = calc;

    const periodStart = lineItem && lineItem.period && lineItem.period.start
        ? new Date(lineItem.period.start * 1000)
        : null;
    const periodEnd = lineItem && lineItem.period && lineItem.period.end
        ? new Date(lineItem.period.end * 1000)
        : null;

    let commission;
    try {
        commission = await Commission.create({
            affiliate: affiliate._id,
            referredUser: referredUser._id,
            stripeInvoiceId: invoice.id,
            stripeSubscriptionId: getSubscriptionIdFromInvoice(invoice),
            plan,
            grossAmountUSD: finalGross,
            commissionPercent,
            commissionAmountUSD,
            periodStart,
            periodEnd,
            status: 'available'
        });
    } catch (err) {
        if (err.code === 11000) {
            return await Commission.findOne({ stripeInvoiceId: invoice.id });
        }
        throw err;
    }

    affiliate.referralStats = affiliate.referralStats || {};
    affiliate.referralStats.totalEarnedUSD = (affiliate.referralStats.totalEarnedUSD || 0) + commissionAmountUSD;
    affiliate.referralStats.pendingUSD = (affiliate.referralStats.pendingUSD || 0) + commissionAmountUSD;
    await affiliate.save();

    await evaluateAutoPromotion(affiliate);

    // Notificación a la afiliada (push + email).
    notifyAffiliateOfCommission(affiliate, referredUser, commissionAmountUSD, plan).catch(e =>
        console.error('[notifyAffiliateOfCommission]', e.message)
    );

    // Logros por hito de comisión (recalcula milestones acumulativos).
    evaluateMilestones(affiliate._id).catch(() => {});

    return commission;
}

// Comisión de una venta de PAGO ÚNICO (ej. plan lifetime $247 → $197 para la afiliada).
// Los pagos únicos de Stripe no generan invoice, así que usamos el id del
// checkout session / payment_intent como clave de idempotencia.
async function recordCommissionForOneTimeSale({
    referredUser, affiliateId, plan, grossAmountUSD, externalId, paidAt
}) {
    if (!referredUser || !affiliateId || !externalId) return null;

    const existing = await Commission.findOne({ stripeInvoiceId: externalId });
    if (existing) return existing;

    const affiliate = await User.findById(affiliateId);
    if (!affiliate) return null;
    // Una afiliada no cobra comisión por su propia compra.
    if (String(affiliate._id) === String(referredUser._id)) return null;

    const calc = calculateCommission(plan, grossAmountUSD);
    if (!calc) {
        console.warn(`[commissions one-time] plan ${plan} sin comisión definida; skip ${externalId}`);
        return null;
    }

    let commission;
    try {
        commission = await Commission.create({
            affiliate: affiliate._id,
            referredUser: referredUser._id,
            stripeInvoiceId: externalId,
            stripeSubscriptionId: null,
            plan,
            grossAmountUSD,
            commissionPercent: calc.percent,
            commissionAmountUSD: calc.amountUSD,
            periodStart: paidAt || new Date(),
            periodEnd: null,
            status: 'available'
        });
    } catch (err) {
        if (err.code === 11000) return await Commission.findOne({ stripeInvoiceId: externalId });
        throw err;
    }

    affiliate.referralStats = affiliate.referralStats || {};
    affiliate.referralStats.totalEarnedUSD = (affiliate.referralStats.totalEarnedUSD || 0) + calc.amountUSD;
    affiliate.referralStats.pendingUSD = (affiliate.referralStats.pendingUSD || 0) + calc.amountUSD;
    await affiliate.save();

    await evaluateAutoPromotion(affiliate);

    notifyAffiliateOfCommission(affiliate, referredUser, calc.amountUSD, plan).catch(e =>
        console.error('[notifyAffiliateOfCommission one-time]', e.message)
    );
    evaluateMilestones(affiliate._id).catch(() => {});

    return commission;
}

async function notifyAffiliateOfCommission(affiliate, referredUser, amountUSD, plan) {
    // Push
    try {
        await sendToUser(affiliate._id, {
            title: '💰 Te llegó comisión',
            body: `${referredUser.username || 'Una alumna'} pagó su plan ${plan}. Ganaste $${amountUSD.toFixed(2)}.`,
            url: '/afiliada',
            tag: `commission-${affiliate._id}`
        });
    } catch (e) { /* noop */ }

    // Email
    if (!affiliate.email || !process.env.RESEND_API_KEY) return;
    try {
        await resend.emails.send({
            from: 'Arquitecta <soporte@arquitectadetupropioexito.com>',
            to: affiliate.email,
            subject: `💰 Nueva comisión: $${amountUSD.toFixed(2)}`,
            html: `
              <div style="font-family:'Helvetica Neue',Arial,sans-serif;background:#F7F2EF;padding:32px 16px;color:#1B3854;">
                <table width="100%" style="max-width:520px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 24px rgba(27,56,84,0.08);">
                  <tr><td style="background:linear-gradient(135deg,#905361 0%,#5E2B35 100%);padding:32px;text-align:center;color:#fff;">
                    <h1 style="margin:0;font-size:24px;">💰 ¡Nueva comisión!</h1>
                    <p style="margin:8px 0 0;font-size:14px;opacity:0.95;">Hola ${affiliate.username || 'Arquitecta'}, una de tus referidas pagó su suscripción.</p>
                  </td></tr>
                  <tr><td style="padding:32px;text-align:center;">
                    <p style="margin:0;color:#64748b;font-size:13px;text-transform:uppercase;letter-spacing:1px;">Ganaste</p>
                    <p style="margin:4px 0 0;font-size:48px;font-weight:700;color:#905361;">$${amountUSD.toFixed(2)}</p>
                    <p style="margin:8px 0 0;color:#475569;font-size:14px;">${referredUser.username || 'Una alumna'} · plan ${plan}</p>
                    <a href="${process.env.FRONTEND_URL || 'https://arquitectadetupropioexito.com'}/afiliada"
                       style="display:inline-block;margin-top:24px;padding:12px 28px;background:#905361;color:#fff;font-weight:700;text-decoration:none;border-radius:12px;">
                      Ver mi panel
                    </a>
                  </td></tr>
                </table>
              </div>`
        });
    } catch (e) { console.error('[email commission]', e.message); }
}

// Cuando una alumna referida se suscribe por primera vez, sumamos al contador de
// totalReferred y activeReferred. Idempotente vía el flag referredCounted.
async function onReferredSubscriptionActivated(referredUser) {
    if (!referredUser || !referredUser.referredBy) return;
    const affiliate = await User.findById(referredUser.referredBy);
    if (!affiliate) return;

    affiliate.referralStats = affiliate.referralStats || {};
    affiliate.referralStats.totalReferred = (affiliate.referralStats.totalReferred || 0) + 1;
    affiliate.referralStats.activeReferred = (affiliate.referralStats.activeReferred || 0) + 1;
    await affiliate.save();

    await evaluateAutoPromotion(affiliate);

    // Recalcula todos los milestones de referidas.
    evaluateMilestones(affiliate._id).catch(() => {});
}

async function onReferredSubscriptionCanceled(referredUser) {
    if (!referredUser || !referredUser.referredBy) return;
    const affiliate = await User.findById(referredUser.referredBy);
    if (!affiliate) return;

    affiliate.referralStats = affiliate.referralStats || {};
    affiliate.referralStats.activeReferred = Math.max(
        0,
        (affiliate.referralStats.activeReferred || 0) - 1
    );
    await affiliate.save();
}

// Marcar una commission como voided (refund) y restar del pendiente.
async function voidCommissionByInvoiceId(invoiceId) {
    const commission = await Commission.findOne({ stripeInvoiceId: invoiceId });
    if (!commission || commission.status === 'voided' || commission.status === 'paid') return commission;

    commission.status = 'voided';
    await commission.save();

    const affiliate = await User.findById(commission.affiliate);
    if (affiliate) {
        affiliate.referralStats = affiliate.referralStats || {};
        affiliate.referralStats.pendingUSD = Math.max(
            0,
            (affiliate.referralStats.pendingUSD || 0) - commission.commissionAmountUSD
        );
        affiliate.referralStats.totalEarnedUSD = Math.max(
            0,
            (affiliate.referralStats.totalEarnedUSD || 0) - commission.commissionAmountUSD
        );
        await affiliate.save();
    }
    return commission;
}

module.exports = {
    recordCommissionFromInvoice,
    recordCommissionFromManualPayment,
    recordCommissionForOneTimeSale,
    backfillCommissionsForUser,
    onReferredSubscriptionActivated,
    onReferredSubscriptionCanceled,
    voidCommissionByInvoiceId
};
