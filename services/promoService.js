// Servicio de promociones activas.
// Por ahora la única promo activable: "trimestral con 1 mes gratis".
// Se guarda en la colección Settings, key = 'promo.quarterly_extra_month'

const Setting = require('../models/Setting');

const PROMO_KEY_QUARTERLY = 'promo.quarterly_extra_month';

async function getQuarterlyPromo() {
    const s = await Setting.findOne({ key: PROMO_KEY_QUARTERLY }).lean();
    return {
        enabled: !!(s && s.value && s.value.enabled),
        extraMonths: s?.value?.extraMonths || 1,
        label: s?.value?.label || '¡Por la compra del trimestral, llévate 1 mes EXTRA!',
        updatedAt: s?.updatedAt || null
    };
}

async function setQuarterlyPromo({ enabled, extraMonths = 1, label, userId }) {
    const value = {
        enabled: !!enabled,
        extraMonths: Math.max(0, Math.min(12, parseInt(extraMonths) || 1)),
        label: label || '¡Por la compra del trimestral, llévate 1 mes EXTRA!'
    };
    await Setting.findOneAndUpdate(
        { key: PROMO_KEY_QUARTERLY },
        { $set: { value, updatedBy: userId || null } },
        { upsert: true, new: true }
    );
    return value;
}

module.exports = { getQuarterlyPromo, setQuarterlyPromo, PROMO_KEY_QUARTERLY };
