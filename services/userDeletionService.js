// Borrado de usuaria con limpieza en cascada.
// Antes solo se borraba el documento User, lo que dejaba:
//   - la suscripción de Stripe ACTIVA (seguía cobrando la tarjeta)
//   - comisiones vivas a favor/en contra de una usuaria inexistente
//   - referidas apuntando a una afiliada fantasma
//   - posts, testimonios, notificaciones y chats huérfanos

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const User = require('../models/User');
const Commission = require('../models/Commission');
const Post = require('../models/Post');
const Testimonial = require('../models/Testimonial');
const PushSubscription = require('../models/PushSubscription');
const QuizAttempt = require('../models/QuizAttempt');
const PartnerApplication = require('../models/PartnerApplication');
const Notification = require('../models/Notification');
const Conversation = require('../models/Chat');
const Course = require('../models/Course');

// Recalcula los referralStats de una afiliada desde la verdad (Users + Commissions).
async function recomputeAffiliateStats(affiliateId) {
    if (!affiliateId) return;
    const [totalReferred, activeReferred, agg] = await Promise.all([
        User.countDocuments({ referredBy: affiliateId }),
        User.countDocuments({
            referredBy: affiliateId,
            'subscription.status': { $in: ['active', 'trialing', 'past_due'] }
        }),
        Commission.aggregate([
            { $match: { affiliate: affiliateId } },
            { $group: { _id: '$status', total: { $sum: '$commissionAmountUSD' } } }
        ])
    ]);
    const byStatus = { available: 0, pending: 0, paid: 0, voided: 0 };
    for (const s of agg) byStatus[s._id] = s.total;

    await User.updateOne({ _id: affiliateId }, {
        $set: {
            'referralStats.totalReferred': totalReferred,
            'referralStats.activeReferred': activeReferred,
            'referralStats.totalEarnedUSD': +(byStatus.available + byStatus.pending + byStatus.paid).toFixed(2),
            'referralStats.pendingUSD': +(byStatus.available + byStatus.pending).toFixed(2),
            'referralStats.paidUSD': +byStatus.paid.toFixed(2)
        }
    });
}

// Cancela la suscripción en Stripe si es real (no manual_ ni lifetime_).
async function cancelStripeSubscription(user, stats) {
    const subId = user?.subscription?.id;
    if (!subId || typeof subId !== 'string') return;

    // Las suscripciones sintéticas no existen en Stripe.
    if (subId.startsWith('manual_') || subId.startsWith('lifetime_')) {
        stats.stripeSkipped = subId.startsWith('lifetime_') ? 'lifetime' : 'manual';
        return;
    }
    if (!process.env.STRIPE_SECRET_KEY) {
        stats.stripeError = 'STRIPE_SECRET_KEY ausente';
        return;
    }

    try {
        const sub = await stripe.subscriptions.retrieve(subId);
        if (['canceled', 'incomplete_expired'].includes(sub.status)) {
            stats.stripeCanceled = 'ya estaba cancelada';
            return;
        }
        await stripe.subscriptions.cancel(subId);
        stats.stripeCanceled = subId;
    } catch (err) {
        // Si ya no existe en Stripe no es un error bloqueante.
        if (err?.statusCode === 404 || err?.code === 'resource_missing') {
            stats.stripeCanceled = 'no existía en Stripe';
        } else {
            stats.stripeError = err.message;
            console.error('[deleteUser] Stripe cancel:', err.message);
        }
    }
}

/**
 * Elimina una usuaria limpiando todo lo asociado.
 * @param {string} userId
 * @param {object} opts { keepPayments = true } — los Payment son historial
 *        financiero y sirven de "ticket" para re-invitar; por defecto se conservan.
 */
async function deleteUserCascade(userId, opts = {}) {
    const { keepPayments = true } = opts;

    const user = await User.findById(userId);
    if (!user) return { ok: false, reason: 'not_found' };

    const stats = {
        email: user.email,
        username: user.username,
        stripeCanceled: null,
        stripeSkipped: null,
        stripeError: null,
        commissionsVoidedAsReferred: 0,
        commissionsVoidedAsAffiliate: 0,
        affiliatesRecalculated: 0,
        referralsOrphaned: 0,
        postsDeleted: 0,
        commentsRemoved: 0,
        testimonialsDeleted: 0,
        notificationsDeleted: 0,
        pushSubsDeleted: 0,
        quizAttemptsDeleted: 0,
        conversationsCleaned: 0,
        paymentsKept: keepPayments
    };

    // 1) Cancelar la suscripción en Stripe (deja de cobrar)
    await cancelStripeSubscription(user, stats);

    // 2) Anular comisiones donde ESTA usuaria fue la referida
    //    (la afiliada no debe cobrar por alguien que ya no existe)
    const asReferred = await Commission.find({
        referredUser: user._id,
        status: { $ne: 'voided' }
    }).select('_id affiliate').lean();

    const affectedAffiliates = new Set();
    if (asReferred.length > 0) {
        await Commission.updateMany(
            { referredUser: user._id, status: { $ne: 'voided' } },
            { $set: { status: 'voided' } }
        );
        stats.commissionsVoidedAsReferred = asReferred.length;
        asReferred.forEach(c => c.affiliate && affectedAffiliates.add(String(c.affiliate)));
    }

    // 3) Anular comisiones donde ESTA usuaria era la afiliada que cobraba
    const asAffiliate = await Commission.countDocuments({
        affiliate: user._id,
        status: { $ne: 'voided' }
    });
    if (asAffiliate > 0) {
        await Commission.updateMany(
            { affiliate: user._id, status: { $ne: 'voided' } },
            { $set: { status: 'voided' } }
        );
        stats.commissionsVoidedAsAffiliate = asAffiliate;
    }

    // 4) Desvincular a las referidas de esta afiliada (evita punteros fantasma)
    const orphaned = await User.updateMany(
        { referredBy: user._id },
        { $set: { referredBy: null } }
    );
    stats.referralsOrphaned = orphaned.modifiedCount || 0;

    // 5) Recalcular stats de las afiliadas afectadas
    for (const affId of affectedAffiliates) {
        if (String(affId) === String(user._id)) continue; // se va a borrar
        try {
            await recomputeAffiliateStats(affId);
            stats.affiliatesRecalculated += 1;
        } catch (e) {
            console.error('[deleteUser] recompute stats', affId, e.message);
        }
    }

    // 6) Contenido generado por la usuaria
    const [posts, testimonials, notifs, pushSubs, attempts] = await Promise.all([
        Post.deleteMany({ author: user._id }),
        Testimonial.deleteMany({ author: user._id }),
        Notification.deleteMany({ $or: [{ recipient: user._id }, { sender: user._id }] }),
        PushSubscription.deleteMany({ user: user._id }),
        QuizAttempt.deleteMany({ user: user._id })
    ]);
    stats.postsDeleted = posts.deletedCount || 0;
    stats.testimonialsDeleted = testimonials.deletedCount || 0;
    stats.notificationsDeleted = notifs.deletedCount || 0;
    stats.pushSubsDeleted = pushSubs.deletedCount || 0;
    stats.quizAttemptsDeleted = attempts.deletedCount || 0;

    // 7) Comentarios, likes y reacciones suyas en posts de otras
    const cleanedComments = await Post.updateMany(
        {},
        {
            $pull: {
                comments: { user: user._id },
                likes: user._id,
                reactions: { user: user._id }
            }
        }
    );
    stats.commentsRemoved = cleanedComments.modifiedCount || 0;

    // 8) Progreso en cursos (completedBy) y matrícula
    await Course.updateMany(
        {},
        { $pull: { students: user._id, 'modules.$[].lessons.$[].completedBy': user._id } }
    ).catch(async () => {
        // Fallback si el driver no soporta el filtro posicional anidado
        await Course.updateMany({}, { $pull: { students: user._id } });
    });

    // 9) Chats: la sacamos de las conversaciones; si queda vacía, se borra
    const convs = await Conversation.updateMany(
        { members: user._id },
        { $pull: { members: user._id } }
    );
    stats.conversationsCleaned = convs.modifiedCount || 0;
    await Conversation.deleteMany({ members: { $size: 0 } });

    // 10) Solicitud de Partner
    await PartnerApplication.deleteMany({ user: user._id });

    // 11) Finalmente, la usuaria
    await User.findByIdAndDelete(user._id);

    return { ok: true, stats };
}

/**
 * Anula las comisiones HUÉRFANAS: aquellas cuya afiliada o cuya referida ya
 * no existe en la base de datos (fueron eliminadas antes de que existiera el
 * borrado en cascada). Se ven en el panel como "—" pero seguían contando
 * como dinero por pagar.
 *
 * @param {object} opts { dryRun = false } — con dryRun solo reporta, no modifica.
 */
async function voidOrphanCommissions(opts = {}) {
    const { dryRun = false } = opts;

    // Solo revisamos las que aún cuentan como dinero vivo.
    const live = await Commission.find({ status: { $ne: 'voided' } })
        .select('_id affiliate referredUser commissionAmountUSD status')
        .lean();

    if (live.length === 0) {
        return { scanned: 0, voided: 0, missingAffiliate: 0, missingReferred: 0, affiliatesRecalculated: 0, amountVoidedUSD: 0 };
    }

    // Qué usuarios referenciados existen realmente.
    const referencedIds = new Set();
    for (const c of live) {
        if (c.affiliate) referencedIds.add(String(c.affiliate));
        if (c.referredUser) referencedIds.add(String(c.referredUser));
    }
    const existing = await User.find({ _id: { $in: [...referencedIds] } }).select('_id').lean();
    const existingSet = new Set(existing.map(u => String(u._id)));

    const toVoid = [];
    let missingAffiliate = 0;
    let missingReferred = 0;
    const affectedAffiliates = new Set();

    for (const c of live) {
        const affOk = c.affiliate && existingSet.has(String(c.affiliate));
        const refOk = c.referredUser && existingSet.has(String(c.referredUser));
        if (affOk && refOk) continue;

        if (!affOk) missingAffiliate += 1;
        if (!refOk) missingReferred += 1;
        toVoid.push(c);
        // Si la afiliada SÍ existe (huérfana solo por la referida), hay que recalcular sus stats.
        if (affOk) affectedAffiliates.add(String(c.affiliate));
    }

    const amountVoidedUSD = +toVoid
        .reduce((s, c) => s + (c.commissionAmountUSD || 0), 0)
        .toFixed(2);

    const stats = {
        scanned: live.length,
        voided: toVoid.length,
        missingAffiliate,
        missingReferred,
        amountVoidedUSD,
        affiliatesRecalculated: 0,
        dryRun
    };

    if (dryRun || toVoid.length === 0) return stats;

    await Commission.updateMany(
        { _id: { $in: toVoid.map(c => c._id) } },
        { $set: { status: 'voided', paidNote: 'Anulada: usuaria eliminada' } }
    );

    for (const affId of affectedAffiliates) {
        try {
            await recomputeAffiliateStats(affId);
            stats.affiliatesRecalculated += 1;
        } catch (e) {
            console.error('[voidOrphanCommissions] recompute', affId, e.message);
        }
    }

    return stats;
}

module.exports = { deleteUserCascade, recomputeAffiliateStats, voidOrphanCommissions };
