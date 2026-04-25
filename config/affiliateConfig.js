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

module.exports = {
    rates,
    prices,
    stripePriceMap,
    promotion,
    levels,
    planFromStripePriceId
};
