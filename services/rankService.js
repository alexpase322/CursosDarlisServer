const User = require('../models/User');
const Commission = require('../models/Commission');
const Notification = require('../models/Notification');
const { sendToUser } = require('./pushService');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const { rankForAmount, rankProgress, byCode } = require('../config/rankConfig');

// ─────────────────────────────────────────────────────────────────────────────
// Rango de Arquitecta: se recalcula cada vez que cambian las comisiones.
// Solo SUBE. Si una comisión se anula y el total baja, el rango alcanzado no se
// retira: quitarle un título ya anunciado a una alumna sería peor que el
// desajuste, y el total real sigue visible en el panel.
// ─────────────────────────────────────────────────────────────────────────────

// Total histórico facturado por la afiliada (no anuladas), la misma base que usa
// el panel de afiliada para `totalEarnedUSD`.
async function totalEarnedFor(userId) {
    const agg = await Commission.aggregate([
        { $match: { affiliate: userId, status: { $ne: 'voided' } } },
        { $group: { _id: null, total: { $sum: '$commissionAmountUSD' } } }
    ]);
    return +(agg[0]?.total || 0).toFixed(2);
}

/**
 * Recalcula el rango de una afiliada y persiste el ascenso si lo hay.
 * Devuelve { totalUSD, current, next, percent, remainingUSD, promoted }.
 */
async function refreshRank(userId, { notify = true } = {}) {
    const user = await User.findById(userId).select('username email rankCode rankLevel rankReachedAt rankHistory');
    if (!user) return null;

    const totalUSD = await totalEarnedFor(user._id);
    const progreso = rankProgress(totalUSD);
    const nuevo = progreso.current;
    const anteriorNivel = user.rankLevel ?? (byCode[user.rankCode]?.level ?? 0);

    let promoted = null;
    if (nuevo.level > anteriorNivel) {
        promoted = nuevo;
        user.rankCode = nuevo.code;
        user.rankLevel = nuevo.level;
        user.rankReachedAt = new Date();
        user.rankHistory = user.rankHistory || [];
        user.rankHistory.push({ code: nuevo.code, level: nuevo.level, reachedAt: user.rankReachedAt, totalUSD });
        await user.save();
        if (notify) notifyPromotion(user, nuevo, totalUSD, progreso.next).catch(() => {});
    } else if (!user.rankCode) {
        // Primera vez: dejamos sembrado el rango base sin anunciar nada.
        user.rankCode = nuevo.code;
        user.rankLevel = nuevo.level;
        await user.save();
    }

    return { totalUSD, ...progreso, promoted };
}

async function notifyPromotion(user, rank, totalUSD, siguiente) {
    const cuerpo = `Alcanzaste ${rank.title} con $${totalUSD.toLocaleString('en-US')} generados.`;

    await Notification.create({
        recipient: user._id,
        type: 'system',
        content: `🏛️ ¡Nuevo rango! Ahora eres ${rank.title}.`,
        link: '/afiliada'
    }).catch(() => {});

    await sendToUser(user._id, {
        title: `🏛️ ¡Subiste de rango!`,
        body: cuerpo,
        url: '/afiliada',
        tag: `rank-${rank.code}`
    }).catch(() => {});

    sendRankEmail(user, rank, totalUSD, siguiente)
        .catch(e => console.error('[email rango]', e.message));
}

// Correo de ascenso. Usa la paleta del propio rango, así el email de Leyenda
// (negro y oro) no se parece al de Constructora (hormigón): el ascenso también
// se ve en la bandeja de entrada.
async function sendRankEmail(user, rank, totalUSD, siguiente) {
    if (!user?.email || !process.env.RESEND_API_KEY) return;

    const base = process.env.FRONTEND_URL || 'https://arquitectadetupropioexito.com';
    const [c1, c2] = rank.gradient;
    const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US');

    const bloqueSiguiente = siguiente
        ? `<tr><td style="padding:0 32px 8px;">
             <div style="background:#F7F2EF;border-radius:14px;padding:18px 20px;text-align:center;">
               <p style="margin:0;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Tu siguiente meta</p>
               <p style="margin:6px 0 0;font-size:20px;font-weight:700;color:#1B3854;">${siguiente.title}</p>
               <p style="margin:4px 0 0;color:#475569;font-size:14px;">
                 Te faltan <strong>${usd(Math.max(0, siguiente.minUSD - totalUSD))}</strong> para llegar.
               </p>
             </div>
           </td></tr>`
        : `<tr><td style="padding:0 32px 8px;">
             <div style="background:#F7F2EF;border-radius:14px;padding:18px 20px;text-align:center;">
               <p style="margin:0;font-size:18px;font-weight:700;color:#1B3854;">Llegaste al rango máximo 🏛️</p>
               <p style="margin:4px 0 0;color:#475569;font-size:14px;">No hay nada por encima de esto.</p>
             </div>
           </td></tr>`;

    await resend.emails.send({
        from: 'Arquitecta <soporte@arquitectadetupropioexito.com>',
        to: user.email,
        subject: `🏛️ ¡Subiste de rango! Ahora eres ${rank.title}`,
        html: `
          <div style="font-family:'Helvetica Neue',Arial,sans-serif;background:#F7F2EF;padding:32px 16px;color:#1B3854;">
            <table width="100%" style="max-width:520px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 24px rgba(27,56,84,0.08);">

              <tr><td style="background:linear-gradient(135deg,${c1} 0%,${c2} 100%);padding:40px 32px;text-align:center;color:${rank.text};">
                <p style="margin:0 0 14px;font-size:11px;letter-spacing:3px;font-weight:700;opacity:.8;">SUBISTE DE RANGO</p>
                <div style="display:inline-block;width:56px;height:56px;line-height:56px;border-radius:50%;background:${rank.accent};color:${c1};font-size:24px;font-weight:700;margin-bottom:14px;">${rank.level}</div>
                <h1 style="margin:0;font-size:34px;color:${rank.accent};">${rank.title}</h1>
                <p style="margin:10px 0 0;font-size:14px;opacity:.9;font-style:italic;">${rank.lema}</p>
              </td></tr>

              <tr><td style="padding:32px 32px 20px;text-align:center;">
                <p style="margin:0;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Generado en total</p>
                <p style="margin:4px 0 0;font-size:42px;font-weight:700;color:#905361;">${usd(totalUSD)}</p>
                <p style="margin:14px 0 0;color:#475569;font-size:15px;line-height:1.6;">
                  Hola ${user.username || 'Arquitecta'}, esto no te lo regaló nadie.<br>Lo construiste tú.
                </p>
              </td></tr>

              ${bloqueSiguiente}

              <tr><td style="padding:24px 32px 36px;text-align:center;">
                <a href="${base}/afiliada"
                   style="display:inline-block;padding:14px 32px;background:#905361;color:#fff;font-weight:700;text-decoration:none;border-radius:12px;">
                  Ver mi rango y descargar mi tarjeta
                </a>
                <p style="margin:16px 0 0;color:#94a3b8;font-size:12px;">
                  En tu panel te espera tu tarjeta de reconocimiento lista para compartir.
                </p>
              </td></tr>

            </table>
          </div>`
    });
}

/**
 * Recalcula el rango de TODAS las afiliadas. Lo usa el botón del panel admin
 * y sirve para sembrar los rangos la primera vez que se activa el sistema.
 */
async function recalculateAllRanks({ notify = false } = {}) {
    // Solo quien tiene al menos una comisión: el resto se queda en Cimientos
    // y no hace falta escribirlo en la base.
    const ids = await Commission.distinct('affiliate', { status: { $ne: 'voided' } });
    let actualizadas = 0, ascensos = 0;

    for (const id of ids) {
        const r = await refreshRank(id, { notify });
        if (!r) continue;
        actualizadas += 1;
        if (r.promoted) ascensos += 1;
    }

    return { evaluadas: ids.length, actualizadas, ascensos };
}

/** Rango de una usuaria sin recalcular (para pintar avatares y el muro). */
function rankOf(user) {
    if (!user) return null;
    const code = user.rankCode;
    if (!code || !byCode[code]) return null;
    return byCode[code];
}

module.exports = { refreshRank, recalculateAllRanks, totalEarnedFor, rankOf, rankForAmount };
