// Servicio centralizado para enviar invitaciones a la plataforma.
// Lo usan tanto el botón manual (controlador inviteUser) como el webhook
// de Stripe cuando entra un pago exitoso (auto-invite).

const crypto = require('crypto');
const { Resend } = require('resend');
const User = require('../models/User');
const Payment = require('../models/Payment');

const resend = new Resend(process.env.RESEND_API_KEY);

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Enviar invitación. Modo:
//   - manual: lanzado por el admin → si el user ya está activo devuelve error.
//   - auto:   lanzado por webhook Stripe → si el user ya está activo o ya se le envió,
//             no hace nada (idempotente, no spammea).
async function sendInvitation({ email, role = 'user', mode = 'manual' }) {
    const normalizedEmail = (email || '').toLowerCase().trim();
    if (!normalizedEmail) {
        return { ok: false, reason: 'email_required' };
    }

    // Buscar usuario existente (case-insensitive).
    let user = await User.findOne({
        email: { $regex: `^${escapeRegex(normalizedEmail)}$`, $options: 'i' }
    });

    if (user && user.status === 'active') {
        return {
            ok: mode === 'auto', // en auto, no es error: simplemente no hay nada que enviar
            reason: 'already_active',
            userId: user._id
        };
    }

    if (user && mode === 'auto' && user.invitationSentAt) {
        // Ya se le envió antes y aún no completó; no spammeamos en cada renovación.
        return { ok: true, reason: 'already_invited', userId: user._id };
    }

    // Crear o reutilizar
    const token = crypto.randomBytes(20).toString('hex');
    if (!user) {
        user = await User.create({
            username: 'Usuario Pendiente',
            email: normalizedEmail,
            role: role || 'user',
            status: 'pending',
            invitationToken: token,
            invitationSentAt: new Date()
        });
    } else {
        user.invitationToken = token;
        user.invitationSentAt = new Date();
        if (role && user.role !== 'admin') user.role = role;
        await user.save();
    }

    // Marcar Payments como consumidos (informativo).
    await Payment.updateMany(
        { email: normalizedEmail, status: 'paid', consumedByInviteAt: null },
        { $set: { consumedByInviteAt: new Date() } }
    );

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const inviteLink = `${frontendUrl}/setup-account/${token}`;
    const whatsappLink = 'https://chat.whatsapp.com/JAwyMpcAIY9HnQwV6xttMD';

    try {
        await resend.emails.send({
            from: 'Arquitecta de tu Propio Éxito <soporte@arquitectadetupropioexito.com>',
            to: email,
            subject: '✨ Bienvenida a Arquitecta — Activa tu acceso',
            html: buildInvitationHtml({ inviteLink, whatsappLink, role })
        });
    } catch (err) {
        console.error('[invitationService] error enviando email:', err);
        return { ok: false, reason: 'email_failed', error: err.message, link: inviteLink, userId: user._id };
    }

    return { ok: true, reason: user.invitationSentAt ? 'sent' : 'created', link: inviteLink, userId: user._id };
}

function buildInvitationHtml({ inviteLink, whatsappLink, role }) {
    const isAdmin = role === 'admin';
    const heroTitle = isAdmin ? '¡Bienvenido al equipo!' : '¡Bienvenida, Arquitecta!';
    const heroSub = isAdmin
        ? 'Tu acceso de administración está listo.'
        : 'Tu camino hacia tu propio éxito empieza hoy.';

    return `
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Bienvenida a Arquitecta</title>
</head>
<body style="margin:0;padding:0;background-color:#F7F2EF;font-family:'Helvetica Neue',Arial,sans-serif;color:#1B3854;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F7F2EF;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 8px 24px rgba(27,56,84,0.08);">

          <!-- HERO -->
          <tr>
            <td style="background:linear-gradient(135deg,#905361 0%,#5E2B35 100%);padding:36px 32px;text-align:center;color:#ffffff;">
              <p style="margin:0 0 8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;opacity:0.85;">Arquitecta de tu Propio Éxito</p>
              <h1 style="margin:0;font-size:26px;font-weight:700;line-height:1.2;">${heroTitle}</h1>
              <p style="margin:12px 0 0;font-size:15px;opacity:0.95;">${heroSub}</p>
            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td style="padding:36px 32px 8px;">
              <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1B3854;">
                Acabamos de confirmar tu acceso a la plataforma. En menos de un minuto vas a poder entrar y empezar a recorrer el método.
              </p>
              <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#1B3854;">
                Activa tu cuenta y crea tu contraseña con el siguiente botón:
              </p>

              <!-- CTA principal -->
              <table cellpadding="0" cellspacing="0" align="center" style="margin:0 auto 24px;">
                <tr>
                  <td align="center" style="border-radius:12px;background:#905361;">
                    <a href="${inviteLink}"
                       style="display:inline-block;padding:14px 36px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">
                      Activar mi cuenta
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 24px;font-size:13px;color:#5E2B35;text-align:center;">
                Este enlace es personal e intransferible.
              </p>
            </td>
          </tr>

          <!-- DIVIDER -->
          <tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid #FDE5E5;margin:0;"/></td></tr>

          <!-- COMUNIDAD -->
          <tr>
            <td style="padding:24px 32px 8px;text-align:center;">
              <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#1B3854;">
                Únete a la comunidad privada
              </p>
              <p style="margin:0 0 18px;font-size:13px;color:#475569;line-height:1.5;">
                Conversaciones, soporte directo y acompañamiento entre Arquitectas.
              </p>
              <table cellpadding="0" cellspacing="0" align="center">
                <tr>
                  <td align="center" style="border-radius:12px;background:#1B3854;">
                    <a href="${whatsappLink}"
                       style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">
                      Entrar al grupo de WhatsApp
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- FALLBACK LINK -->
          <tr>
            <td style="padding:24px 32px 8px;">
              <p style="margin:0 0 6px;font-size:12px;color:#64748b;">
                ¿El botón no abre? Copia y pega este enlace en tu navegador:
              </p>
              <p style="margin:0;font-size:12px;color:#905361;word-break:break-all;">${inviteLink}</p>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="padding:24px 32px 32px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
                Si no esperabas este correo, simplemente ignóralo.<br/>
                © ${new Date().getFullYear()} Arquitecta de tu Propio Éxito.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = { sendInvitation };
