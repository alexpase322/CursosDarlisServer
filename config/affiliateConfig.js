// Configuración del programa de afiliadas.
// Las claves STRIPE_PRICE_* las rellena el admin en .env con los IDs reales de Stripe.

// PLANES A LA VENTA hoy: solo mensual ($50) y pago único ($247).
// `quarterly` y `yearly` quedan DESCONTINUADOS: ya no se ofrecen en la landing,
// pero se mantienen aquí para que las alumnas que ya los tienen sigan renovando
// y generando su comisión correctamente. No borrar.
const sellablePlans = ['monthly', 'lifetime'];
const legacyPlans = ['quarterly', 'yearly'];
const isSellablePlan = (plan) => sellablePlans.includes(plan);

// Comisiones porcentuales (planes de suscripción recurrente).
const rates = {
    monthly: 0.40,
    quarterly: 0.40,  // legacy
    yearly: 0.50      // legacy
};

// Comisiones de monto FIJO (planes de pago único). Tienen prioridad sobre `rates`.
// lifetime: $247 → $197 para la afiliada, $50 para Arquitecta.
const flatCommissions = {
    lifetime: 197
};

const prices = {
    monthly: 50,
    quarterly: 120,   // legacy
    yearly: 397,      // legacy
    lifetime: 247
};

// Planes de pago único (Stripe checkout en mode:'payment', no 'subscription').
const oneTimePlans = ['lifetime'];
const isOneTimePlan = (plan) => oneTimePlans.includes(plan);

const stripePriceMap = {
    [process.env.STRIPE_PRICE_MONTHLY   || '__unset_monthly__']:   'monthly',
    [process.env.STRIPE_PRICE_QUARTERLY || '__unset_quarterly__']: 'quarterly',
    [process.env.STRIPE_PRICE_YEARLY    || '__unset_yearly__']:    'yearly',
    [process.env.STRIPE_PRICE_LIFETIME  || '__unset_lifetime__']:  'lifetime'
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

// Calcula la comisión de una venta según el plan.
// Devuelve { amountUSD, percent } — usa monto fijo si el plan lo define,
// si no aplica el porcentaje sobre el bruto cobrado.
function calculateCommission(plan, grossAmountUSD) {
    const gross = Number(grossAmountUSD) || 0;

    if (flatCommissions[plan] != null) {
        const amount = flatCommissions[plan];
        return {
            amountUSD: +amount.toFixed(2),
            percent: gross > 0 ? +((amount / gross) * 100).toFixed(2) : 0
        };
    }

    const rate = rates[plan];
    if (!rate) return null;
    return {
        amountUSD: +(gross * rate).toFixed(2),
        percent: +(rate * 100).toFixed(2)
    };
}

// Deduce el plan desde un line_item de Stripe usando, en orden:
//   1) priceId mapeado en .env (STRIPE_PRICE_*)
//   2) pago único (sin `recurring`) con monto ≈247 → lifetime
//   3) recurring.interval + interval_count (month×1, month×3, year×1)
//   4) monto como último recurso
function inferPlan({ priceId, lineItem, amountUSD } = {}) {
    let plan = planFromStripePriceId(priceId);
    if (plan) return plan;

    const price = lineItem && lineItem.price;
    const recurring = (price && price.recurring) || (lineItem && lineItem.recurring);
    const amt = Number(amountUSD);

    // Pago único: no tiene `recurring`. Si el monto está en el rango de lifetime, lo marcamos.
    if (price && !recurring) {
        if (Number.isFinite(amt) && amt >= 200 && amt < 300) return 'lifetime';
    }

    if (recurring && recurring.interval) {
        const interval = recurring.interval;
        const count = recurring.interval_count || 1;
        if (interval === 'year') return 'yearly';
        if (interval === 'month' && count >= 12) return 'yearly';
        if (interval === 'month' && count === 3) return 'quarterly';
        if (interval === 'month' && count === 1) return 'monthly';
    }

    if (Number.isFinite(amt) && amt > 0) {
        // Buckets tolerantes (descuentos, impuestos, redondeo Stripe).
        if (amt >= 300) return 'yearly';
        if (amt >= 200) return 'lifetime';   // 247 pago único
        if (amt >= 90)  return 'quarterly';
        if (amt >= 1)   return 'monthly';
    }
    return null;
}

module.exports = {
    rates,
    flatCommissions,
    prices,
    sellablePlans,
    legacyPlans,
    isSellablePlan,
    oneTimePlans,
    isOneTimePlan,
    stripePriceMap,
    promotion,
    levels,
    planFromStripePriceId,
    calculateCommission,
    inferPlan
};
