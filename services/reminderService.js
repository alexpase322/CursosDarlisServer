// Recordatorios automáticos por email + push.
// Corre 1 vez al día (cron) y manda emails a alumnas que llevan inactivas N días.
//
// Reglas (no spammear):
// - Después de 3 días sin entrar → mensaje suave.
// - Después de 7 días sin entrar → mensaje "te extrañamos".
// - Después de 14 días sin entrar → último intento.
// - Idempotente: User.lastReminderSentAt + User.lastReminderType evitan re-envíos.

const User = require('../models/User');
const { Resend } = require('resend');
const { sendToUser } = require('./pushService');

const resend = new Resend(process.env.RESEND_API_KEY);

const TIERS = [
    { days: 3,  type: 'gentle',   subject: '👋 ¿Todo bien? Te esperamos por aquí',
      body: 'Hace unos días no entras. Tu próximo paso del método te está esperando.' },
    { days: 7,  type: 'engaged',  subject: '💛 Te extrañamos, Arquitecta',
      body: 'Una semana sin pasar es mucho. Vuelve y retoma justo donde lo dejaste.' },
    { days: 14, type: 'final',    subject: '⏳ Antes de que se enfríe...',
      body: 'No queremos que pierdas el ritmo que ya empezaste a construir. Entra hoy y avancemos juntas.' }
];

const daysSince = (date) => Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));

async function runReminderJob({ dryRun = false, log = console.log } = {}) {
    if (!process.env.RESEND_API_KEY) {
        log('[reminders] RESEND_API_KEY ausente; skip.');
        return { skipped: true };
    }

    // Solo usuarias activas (status active) — las pending/canceled no nos interesan.
    const candidates = await User.find({
        status: 'active',
        role: { $ne: 'admin' },
        lastActiveAt: { $ne: null }
    }).select('email username lastActiveAt lastReminderSentAt lastReminderType').lean();

    let sent = 0, skipped = 0;
    for (const u of candidates) {
        const inactive = daysSince(u.lastActiveAt);
        // Encontrar el tier más alto cuyo umbral se cumple.
        let tier = null;
        for (const t of TIERS) {
            if (inactive >= t.days) tier = t;
        }
        if (!tier) { skipped += 1; continue; }
        if (u.lastReminderType === tier.type) { skipped += 1; continue; } // ya enviado

        if (dryRun) { sent += 1; log(`[reminders] DRY would send '${tier.type}' to ${u.email}`); continue; }

        try {
            await resend.emails.send({
                from: 'Arquitecta <soporte@arquitectadetupropioexito.com>',
                to: u.email,
                subject: tier.subject,
                html: buildReminderHtml({ name: u.username || 'Arquitecta', body: tier.body, days: inactive })
            });
            sent += 1;
            await User.updateOne(
                { _id: u._id },
                { $set: { lastReminderSentAt: new Date(), lastReminderType: tier.type } }
            );
            // Push también
            sendToUser(u._id, {
                title: tier.subject,
                body: tier.body,
                url: '/dashboard',
                tag: `reminder-${tier.type}`
            }).catch(() => {});
        } catch (err) {
            log(`[reminders] error ${u.email}: ${err.message}`);
        }
    }

    log(`[reminders] sent=${sent} skipped=${skipped} candidates=${candidates.length}`);
    return { sent, skipped, total: candidates.length };
}

function buildReminderHtml({ name, body, days }) {
    const url = `${process.env.FRONTEND_URL || 'https://arquitectadetupropioexito.com'}/dashboard`;
    return `
<div style="font-family:'Helvetica Neue',Arial,sans-serif;background:#F7F2EF;padding:32px 16px;color:#1B3854;">
  <table width="100%" style="max-width:520px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 24px rgba(27,56,84,0.08);">
    <tr><td style="background:linear-gradient(135deg,#905361 0%,#5E2B35 100%);padding:32px;text-align:center;color:#fff;">
      <h1 style="margin:0;font-size:24px;">Hola, ${name}</h1>
      <p style="margin:8px 0 0;font-size:14px;opacity:0.95;">Llevas ${days} días sin entrar a la plataforma.</p>
    </td></tr>
    <tr><td style="padding:32px;text-align:center;">
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">${body}</p>
      <a href="${url}" style="display:inline-block;padding:12px 28px;background:#905361;color:#fff;font-weight:700;text-decoration:none;border-radius:12px;">
        Volver a entrar
      </a>
      <p style="margin:24px 0 0;font-size:12px;color:#94a3b8;">Si no quieres recibir más recordatorios, escríbenos.</p>
    </td></tr>
  </table>
</div>`;
}

module.exports = { runReminderJob };
