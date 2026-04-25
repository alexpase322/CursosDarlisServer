// Configuración del programa de afiliadas.
// Las claves STRIPE_PRICE_* las rellena el admin en .env con los IDs reales de Stripe.

const rates = {
    monthly: 0.40,
    quarterly: 0.40,
    yearly: 0.50
};

const prices = {
    monthly: 50,
    quarterly: 120,
    yearly: 397
};

const stripePriceMap = {
    [process.env.STRIPE_PRICE_MONTHLY || '__unset_monthly__']: 'monthly',
    [process.env.STRIPE_PRICE_QUARTERLY || '__unset_quarterly__']: 'quarterly',
    [process.env.STRIPE_PRICE_YEARLY || '__unset_yearly__']: 'yearly'
};

const promotion = {
    n2ToN3: { activeReferralsRequired: 40 }
};

const levels = {
    1: { name: 'Alumna',           color: '#94a3b8', icon: 'User' },
    2: { name: 'Partner activada', color: '#905361', icon: 'Sparkles' },
    3: { name: 'Seller autorizada',color: '#1B3854', icon: 'Award' },
    4: { name: 'Closer interna',   color: '#D4AF37', icon: 'Crown' }
};

function planFromStripePriceId(priceId) {
    if (!priceId) return null;
    return stripePriceMap[priceId] || null;
}

// Deduce el plan desde un line_item de Stripe usando, en orden:
//   1) priceId mapeado en .env (STRIPE_PRICE_*)
//   2) recurring.interval + interval_count (month×1, month×3, year×1)
//   3) monto (≈$50, ≈$120, ≈$397) como último recurso
function inferPlan({ priceId, lineItem, amountUSD } = {}) {
    let plan = planFromStripePriceId(priceId);
    if (plan) return plan;

    const price = lineItem && lineItem.price;
    const recurring = (price && price.recurring) || (lineItem && lineItem.recurring);
    if (recurring && recurring.interval) {
        const interval = recurring.interval;
        const count = recurring.interval_count || 1;
        if (interval === 'year') return 'yearly';
        if (interval === 'month' && count >= 12) return 'yearly';
        if (interval === 'month' && count === 3) return 'quarterly';
        if (interval === 'month' && count === 1) return 'monthly';
    }

    const amt = Number(amountUSD);
    if (Number.isFinite(amt) && amt > 0) {
        // Buckets tolerantes (descuentos, impuestos, redondeo Stripe).
        if (amt >= 250) return 'yearly';
        if (amt >= 90)  return 'quarterly';
        if (amt >= 1)   return 'monthly';
    }
    return null;
}

module.exports = {
    rates,
    prices,
    stripePriceMap,
    promotion,
    levels,
    planFromStripePriceId,
    inferPlan
};
