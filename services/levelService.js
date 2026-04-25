const User = require('../models/User');
const { promotion } = require('../config/affiliateConfig');

// Auto-promoción según el documento (sec. 5.2): N2→N3 al alcanzar 40 alumnas
// activas referidas. N1→N2 nunca es automático (requiere PartnerApplication).
// N3→N4 nunca es automático (solo por invitación del admin).
async function evaluateAutoPromotion(user) {
    if (!user || user.partnerLevelSetManually) return user;

    if (
        user.partnerLevel === 2 &&
        user.referralStats &&
        user.referralStats.activeReferred >= promotion.n2ToN3.activeReferralsRequired &&
        user.trainingCompleted === true
    ) {
        user.partnerLevel = 3;
        await user.save();
    }

    return user;
}

async function setLevelManually(userId, newLevel) {
    if (![1, 2, 3, 4].includes(newLevel)) {
        throw new Error('Nivel inválido');
    }
    const user = await User.findById(userId);
    if (!user) throw new Error('Usuario no encontrado');

    const wasBelowN2 = user.partnerLevel < 2;
    user.partnerLevel = newLevel;
    user.partnerLevelSetManually = true;
    if (wasBelowN2 && newLevel >= 2 && !user.partnerActivatedAt) {
        user.partnerActivatedAt = new Date();
    }
    await user.save();
    return user;
}

module.exports = { evaluateAutoPromotion, setLevelManually };
