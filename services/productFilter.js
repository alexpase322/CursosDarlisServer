const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { resolveArquitectaPlan, extractPriceRef, isBeaconsSale } = require('../config/affiliateConfig');

// ─────────────────────────────────────────────────────────────────────────
// FILTRO DE PRODUCTO.
// La cuenta de Stripe cobra varios negocios: los payment plans de $199/$250/$170,
// los cursos DWA y las ventas de Beacons (Arquitecta, pero también "Mini curso
// AMAZON AL DESCUBIERTO"). Antes el plan se adivinaba por el monto y cualquiera
// de esos pagos podía dar acceso a Arquitecta.
//
// Se resuelve en dos niveles:
//   1) por price/producto conocido  → ventas desde la web (IDs estables)
//   2) por NOMBRE del producto      → ventas de Beacons, que crea un producto
//      efímero por venta ("Invoice paid by … on Beacons for <PRODUCTO> - <uuid>")
// ─────────────────────────────────────────────────────────────────────────

// Beacons genera un producto por venta: sin caché haríamos una llamada a Stripe
// por cada evento. Se guarda también el resultado negativo.
const productNameCache = new Map();

const getProductName = async (productId) => {
    if (!productId) return null;
    if (productNameCache.has(productId)) return productNameCache.get(productId);
    let name = null;
    try {
        const p = await stripe.products.retrieve(productId);
        name = p?.name || null;
    } catch (err) {
        console.error(`[filtro-producto] no pude leer ${productId}:`, err.message);
        return null;   // no cacheamos fallos de red
    }
    if (productNameCache.size > 1000) productNameCache.clear();
    productNameCache.set(productId, name);
    return name;
};

/**
 * Decide si un cobro de Stripe corresponde a Arquitecta.
 * Devuelve { ok, plan, productName, esBeacons }.
 * Si ok=false hay que ignorar el evento entero.
 */
const checkArquitecta = async ({ priceId, product, lineItem, contexto = 'evento', silencioso = false } = {}) => {
    let plan = resolveArquitectaPlan({ priceId, product, lineItem });

    // Nombre ya disponible si el producto viene expandido.
    let nombre = (typeof product === 'object' ? product?.name : null)
        || (typeof lineItem?.price?.product === 'object' ? lineItem.price.product?.name : null)
        || null;

    // Si no se reconoció y solo tenemos el ID del producto, puede ser una venta
    // de Beacons (producto efímero): hay que leer su nombre para decidir.
    const ref = extractPriceRef(lineItem);
    const prodId = (typeof product === 'string' ? product : product?.id) || ref.productId;
    if (!nombre && prodId) nombre = await getProductName(prodId);
    if (!plan && nombre) {
        plan = resolveArquitectaPlan({ priceId, lineItem, productName: nombre });
        if (plan && !silencioso) {
            console.log(`[filtro-producto] ${contexto}: venta de Beacons reconocida — "${nombre}"`);
        }
    }

    if (!plan) {
        if (!silencioso) {
            console.log(
                `[filtro-producto] ${contexto} IGNORADO: no es de Arquitecta ` +
                `(price=${priceId || ref.priceId || '?'}, product=${prodId || '?'}` +
                `${nombre ? `, nombre="${nombre.slice(0, 60)}"` : ''})`
            );
        }
        return { ok: false, plan: null, productName: nombre, esBeacons: false };
    }
    return { ok: true, plan, productName: nombre, esBeacons: isBeaconsSale(nombre) };
};

module.exports = { checkArquitecta, getProductName };
