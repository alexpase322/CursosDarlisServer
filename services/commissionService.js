const Commission = require('../models/Commission');
const User = require('../models/User');
const { rates, prices, planFromStripePriceId } = require('../config/affiliateConfig');
const { evaluateAutoPromotion } = require('./levelService');

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
async function recordCommissionFromInvoice(invoice) {
    if (!invoice || !invoice.id) return null;

    const existing = await Commission.findOne({ stripeInvoiceId: invoice.id });
    if (existing) return existing;

    const customerId = invoice.customer;
    const referredUser = await User.findOne({ 'subscription.customerId': customerId });
    if (!referredUser) return null;
    if (!referredUser.referredBy) return null;

    const affiliate = await User.findById(referredUser.referredBy);
    if (!affiliate) return null;

    const lineItem = invoice.lines && invoice.lines.data && invoice.lines.data[0];
    const priceId = lineItem && lineItem.price && lineItem.price.id;
    const plan = planFromStripePriceId(priceId);
    if (!plan) {
        console.warn(`[commissions] priceId ${priceId} no mapea a ningún plan; skip.`);
        return null;
    }

    const grossAmountUSD = invoice.amount_paid != null
        ? invoice.amount_paid / 100
        : prices[plan];
    const commissionPercent = rates[plan] * 100;
    const commissionAmountUSD = +(grossAmountUSD * rates[plan]).toFixed(2);

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
            grossAmountUSD,
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

    return commission;
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
    onReferredSubscriptionActivated,
    onReferredSubscriptionCanceled,
    voidCommissionByInvoiceId
};
