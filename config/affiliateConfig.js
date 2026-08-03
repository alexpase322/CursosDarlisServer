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

// Price IDs de lifetime CONOCIDOS (además del que esté en STRIPE_PRICE_LIFETIME).
// Se pueden tener varios precios de $247 para el mismo producto de pago único.
// Añadir aquí cualquier price nuevo de pago único garantiza detección exacta.
const KNOWN_LIFETIME_PRICE_IDS = [
    'price_1TwRRIDP5qCZDXVtNjnVkXkn'
];

const stripePriceMap = {
    [process.env.STRIPE_PRICE_MONTHLY   || '__unset_monthly__']:   'monthly',
    [process.env.STRIPE_PRICE_QUARTERLY || '__unset_quarterly__']: 'quarterly',
    [process.env.STRIPE_PRICE_YEARLY    || '__unset_yearly__']:    'yearly',
    [process.env.STRIPE_PRICE_LIFETIME  || '__unset_lifetime__']:  'lifetime'
};
// Registrar los lifetime conocidos en el mapa.
for (const id of KNOWN_LIFETIME_PRICE_IDS) stripePriceMap[id] = 'lifetime';

// ─────────────────────────────────────────────────────────────────────────
// PRODUCTOS DE ARQUITECTA (allowlist).
// La cuenta de Stripe también recibe pagos de OTROS negocios cuyos montos se
// parecen ($199, $250, $170…). Adivinar el plan por el monto daba accesos por
// error, así que la fuente de verdad es el PRODUCTO de Stripe.
// Ventaja: un producto puede tener varios precios (hoy $197, mañana $247) y
// todos quedan cubiertos sin tocar código.
// ─────────────────────────────────────────────────────────────────────────
const arquitectaProducts = {
    'prod_UwK5fQhEuzH6L5': 'lifetime',   // Arquitecta de tu propio éxito (único pago) — $197 promo / $247
    'prod_Tl5UNZQLJP41ce': 'monthly',    // Membresía mensual — $50
    'prod_UBohkEJ6PB1czo': 'monthly',    // darlisfrancofv - subscription — $50
    // Legacy: ya no se venden, pero hay alumnas activas que deben seguir renovando.
    'prod_Tl5VnpAOIXXLbd': 'quarterly',  // Membresía trimestral — $120
    'prod_UOfKffaHV4Po7h': 'yearly'      // Membresía anual — $397
};

// Permite añadir productos desde el entorno sin tocar código:
// STRIPE_EXTRA_PRODUCTS="prod_ABC:monthly,prod_XYZ:lifetime"
if (process.env.STRIPE_EXTRA_PRODUCTS) {
    for (const par of process.env.STRIPE_EXTRA_PRODUCTS.split(',')) {
        const [pid, plan] = par.split(':').map(s => (s || '').trim());
        if (pid && plan) arquitectaProducts[pid] = plan;
    }
}

// ─────────────────────────────────────────────────────────────────────────
// VENTAS DE BEACONS.
// Beacons cobra a través de esta cuenta de Stripe y crea un producto NUEVO por
// cada venta, con este nombre:
//   "Invoice paid by <nombre> on Beacons for <PRODUCTO> - <uuid>"
// El ID cambia siempre, así que la lista de productos no sirve para estas
// ventas: hay que reconocer el nombre. En Beacons también se venden otros
// cursos (p. ej. "Mini curso AMAZON AL DESCUBIERTO"), que deben quedar fuera.
// ─────────────────────────────────────────────────────────────────────────
const arquitectaNamePattern = /arquitecta\s+de\s+tu\s+propio\s+[éeÉE]xito/i;

// Beacons solo vende el programa de pago único ($197 promo → $247).
function planFromProductName(name) {
    if (!name || typeof name !== 'string') return null;
    return arquitectaNamePattern.test(name) ? 'lifetime' : null;
}

// En las ventas de Beacons la comisión la paga Beacons directamente a la
// afiliada; nosotros solo la registramos para trazabilidad.
const beaconsNamePattern = /\bon\s+Beacons\s+for\b/i;
const isBeaconsSale = (name) => typeof name === 'string' && beaconsNamePattern.test(name);

const idOf = (v) => (typeof v === 'string' ? v : v?.id) || null;

// Stripe expone el precio con formas distintas según el objeto y la versión de API:
//   · items de suscripción y line items de checkout → lineItem.price.{id,product}
//   · líneas de invoice (API nueva)                 → lineItem.pricing.price_details.{price,product}
//   · objetos antiguos con plan                     → lineItem.plan.{id,product}
// Leer solo `.price` devolvía undefined en las invoices, que era justo lo que
// hacía caer la detección al fallback por monto.
function extractPriceRef(lineItem) {
    if (!lineItem) return { priceId: null, productId: null };
    const details = lineItem.pricing?.price_details;
    return {
        priceId:
            idOf(lineItem.price) ||
            (details?.price ?? null) ||
            idOf(lineItem.plan),
        productId:
            idOf(lineItem.price?.product) ||
            (details?.product ?? null) ||
            idOf(lineItem.plan?.product)
    };
}

/**
 * Determina el plan de Arquitecta de forma ESTRICTA.
 * Devuelve el plan, o null si el pago NO pertenece a Arquitecta (otro negocio).
 * A diferencia de inferPlan(), nunca adivina por monto.
 */
function resolveArquitectaPlan({ priceId, product, lineItem, productName } = {}) {
    const ref = extractPriceRef(lineItem);
    const pid = priceId || ref.priceId;

    // 1) Price exacto conocido (.env o lista de lifetime)
    if (pid && stripePriceMap[pid]) return stripePriceMap[pid];

    // 2) Producto en la allowlist — cubre precios nuevos del mismo producto
    const prod = idOf(product) || ref.productId;
    if (prod && arquitectaProducts[prod]) return arquitectaProducts[prod];

    // 3) Producto efímero de Beacons: se reconoce por el nombre
    const nombre = productName
        || (typeof product === 'object' ? product?.name : null)
        || (typeof lineItem?.price?.product === 'object' ? lineItem.price.product?.name : null)
        || lineItem?.description;
    const porNombre = planFromProductName(nombre);
    if (porNombre) return porNombre;

    // 4) No es de Arquitecta
    return null;
}

const isArquitectaProduct = (product) => {
    const pid = idOf(product);
    return !!(pid && arquitectaProducts[pid]);
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
    arquitectaProducts,
    resolveArquitectaPlan,
    isArquitectaProduct,
    extractPriceRef,
    planFromProductName,
    arquitectaNamePattern,
    isBeaconsSale,
    promotion,
    levels,
    planFromStripePriceId,
    calculateCommission,
    inferPlan
};
