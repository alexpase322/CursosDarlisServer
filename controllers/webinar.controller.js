const WebinarLead = require('../models/WebinarLead');
const { Resend } = require('resend');
const validator = require('validator');
const { safeSearchRegex } = require('../middleware/security');
const resend = new Resend(process.env.RESEND_API_KEY);

// POST /webinar/register  — público
const registerLead = async (req, res) => {
    try {
        let { name, email, phone = '', source = 'webinar-page' } = req.body || {};

        // Validación / saneo de entrada
        name = typeof name === 'string' ? name.trim().slice(0, 100) : '';
        email = typeof email === 'string' ? email.trim().toLowerCase().slice(0, 150) : '';
        phone = typeof phone === 'string' ? phone.trim().slice(0, 40) : '';
        source = typeof source === 'string' ? source.trim().slice(0, 60) : 'webinar-page';

        if (!name || !email) return res.status(400).json({ message: 'Nombre y email son obligatorios' });
        if (!validator.isEmail(email)) return res.status(400).json({ message: 'Email inválido' });

        const normalized = email;

        // Idempotente por email + source: si ya se registró, actualizamos sus datos.
        const existing = await WebinarLead.findOne({ email: normalized, source });
        let lead;
        if (existing) {
            existing.name = name;
            existing.phone = phone || existing.phone;
            existing.userAgent = req.headers['user-agent'] || existing.userAgent;
            existing.ip = req.ip || existing.ip;
            lead = await existing.save();
        } else {
            lead = await WebinarLead.create({
                name, email: normalized, phone, source,
                ip: req.ip || '',
                userAgent: req.headers['user-agent'] || ''
            });
        }

        // Email de confirmación (no bloqueante)
        if (process.env.RESEND_API_KEY) {
            const frontendUrl = process.env.FRONTEND_URL || 'https://arquitectadetupropioexito.com';
            resend.emails.send({
                from: 'Arquitecta <soporte@arquitectadetupropioexito.com>',
                to: email,
                subject: '🎬 Tu acceso al webinar gratuito',
                html: `
<div style="font-family:'Helvetica Neue',Arial,sans-serif;background:#F7F2EF;padding:32px 16px;color:#1B3854;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 24px rgba(27,56,84,0.08);">
    <tr><td style="background:linear-gradient(135deg,#905361 0%,#5E2B35 100%);padding:36px 32px;text-align:center;color:#fff;">
      <p style="margin:0 0 8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;opacity:0.85;">Arquitecta de tu Propio Éxito</p>
      <h1 style="margin:0;font-size:26px;font-weight:700;">¡Hola ${name.split(' ')[0]}!</h1>
      <p style="margin:12px 0 0;font-size:15px;opacity:0.95;">Gracias por registrarte. Aquí está tu acceso.</p>
    </td></tr>
    <tr><td style="padding:32px;text-align:center;">
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">
        Reserva 30 minutos sin interrupciones. Lo que vas a ver puede cambiar la forma en la que piensas tu negocio.
      </p>
      <a href="${frontendUrl}/webinar"
         style="display:inline-block;padding:14px 36px;background:#905361;color:#fff;font-weight:700;text-decoration:none;border-radius:12px;">
        Ver el webinar ahora
      </a>
      <p style="margin:24px 0 0;font-size:13px;color:#64748b;">
        Si quieres conocer la membresía completa, al final del video tienes un botón para inscribirte.
      </p>
    </td></tr>
    <tr><td style="padding:0 32px 28px;text-align:center;border-top:1px solid #FDE5E5;">
      <p style="margin:20px 0 0;font-size:12px;color:#94a3b8;">
        © ${new Date().getFullYear()} Arquitecta de tu Propio Éxito
      </p>
    </td></tr>
  </table>
</div>`
            }).catch(e => console.warn('[webinar email]', e.message));
        }

        res.status(201).json({ ok: true, leadId: lead._id });
    } catch (err) {
        console.error('registerLead', err);
        res.status(500).json({ message: 'Error al registrar' });
    }
};

// POST /webinar/mark-watched/:id — público (lo dispara el frontend cuando termina el video)
const markWatched = async (req, res) => {
    try {
        const { id } = req.params;
        await WebinarLead.updateOne({ _id: id }, { $set: { watchedFull: true } });
        res.json({ ok: true });
    } catch {
        res.json({ ok: true }); // no bloqueamos al usuario por esto
    }
};

// GET /admin/webinar/leads — solo admin
const listLeads = async (req, res) => {
    try {
        const { q, source, page = 1, limit = 50 } = req.query;
        const filter = {};
        if (q) filter.$or = [
            { name: safeSearchRegex(q) },
            { email: safeSearchRegex(q) }
        ];
        if (source) filter.source = source;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [items, total, summary] = await Promise.all([
            WebinarLead.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
            WebinarLead.countDocuments(filter),
            WebinarLead.aggregate([
                { $match: filter },
                { $group: {
                    _id: null,
                    total: { $sum: 1 },
                    watched: { $sum: { $cond: ['$watchedFull', 1, 0] } },
                    converted: { $sum: { $cond: ['$converted', 1, 0] } }
                } }
            ])
        ]);
        res.json({
            items, total, page: parseInt(page), limit: parseInt(limit),
            summary: summary[0] || { total: 0, watched: 0, converted: 0 }
        });
    } catch (err) {
        console.error('listLeads', err);
        res.status(500).json({ message: 'Error al listar leads' });
    }
};

module.exports = { registerLead, markWatched, listLeads };
