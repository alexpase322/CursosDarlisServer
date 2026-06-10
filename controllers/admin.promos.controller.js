const { getQuarterlyPromo, setQuarterlyPromo } = require('../services/promoService');

// GET /admin/promos/quarterly  → estado actual de la promo trimestral
const getPromo = async (req, res) => {
    try {
        const promo = await getQuarterlyPromo();
        res.json(promo);
    } catch (err) {
        console.error('getPromo', err);
        res.status(500).json({ message: 'Error al obtener promo' });
    }
};

// PUT /admin/promos/quarterly  body: { enabled, extraMonths, label }
const updatePromo = async (req, res) => {
    try {
        const { enabled, extraMonths = 1, label } = req.body || {};
        const promo = await setQuarterlyPromo({
            enabled, extraMonths, label, userId: req.user?._id
        });
        res.json({ ok: true, promo });
    } catch (err) {
        console.error('updatePromo', err);
        res.status(500).json({ message: 'Error al actualizar promo' });
    }
};

// GET /promos/active  → endpoint público para mostrar en la landing
const getPublicPromo = async (req, res) => {
    try {
        const promo = await getQuarterlyPromo();
        // Solo exponemos lo necesario para la landing.
        res.json({
            quarterly: {
                enabled: promo.enabled,
                extraMonths: promo.extraMonths,
                label: promo.label
            }
        });
    } catch (err) {
        res.json({ quarterly: { enabled: false, extraMonths: 0, label: '' } });
    }
};

module.exports = { getPromo, updatePromo, getPublicPromo };
