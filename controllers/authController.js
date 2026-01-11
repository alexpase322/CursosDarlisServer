const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
// const nodemailer = require('nodemailer'); <--- YA NO LO USAMOS
const { Resend } = require('resend'); // <--- NUEVO
const cloudinary = require('../config/cloudinary'); 
const fs = require('fs');
const crypto = require('crypto');

// Inicializar Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Generar Token JWT
const generateToken = (id, role) => {
    return jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

// @desc    Registrar nuevo usuario
// @route   POST /api/auth/register
const registerUser = async (req, res) => {
    const { username, email, password } = req.body;

    try {
        const userExists = await User.findOne({ email });
        if (userExists) {
            return res.status(400).json({ message: 'El usuario ya existe' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const user = await User.create({
            username,
            email,
            password: hashedPassword,
        });

        if (user) {
            res.status(201).json({
                _id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                token: generateToken(user.id, user.role),
            });
        } else {
            res.status(400).json({ message: 'Datos de usuario inválidos' });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Login de usuario
// @route   POST /api/auth/login
const loginUser = async (req, res) => {
    const { email, password } = req.body;

    try {
        const user = await User.findOne({ email });

        if (user && (await bcrypt.compare(password, user.password))) {
            res.json({
                _id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                avatar: user.avatar,
                token: generateToken(user.id, user.role),
            });
        } else {
            res.status(401).json({ message: 'Email o contraseña incorrectos' });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getProfile = async (req, res) => {
    const user = {
        _id: req.user._id,
        username: req.user.username,
        email: req.user.email,
        role: req.user.role,
        avatar: req.user.avatar,
        bio: req.user.bio
    }
    res.status(200).json(user);
};

// --- AQUÍ ESTÁ EL CAMBIO IMPORTANTE ---
const inviteUser = async (req, res) => {
  const { email, role } = req.body;

  try {
    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: 'El usuario ya existe' });
    }

    const token = crypto.randomBytes(20).toString('hex');

    const user = await User.create({
      username: 'Usuario Pendiente', 
      email,
      role: role || 'user',
      status: 'pending',
      invitationToken: token
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const inviteLink = `${frontendUrl}/setup-account/${token}`;

    // USANDO RESEND (Nunca da timeout en Render)
    await resend.emails.send({
      from: 'alexpase32@gmail.com', // Usa este remitente de prueba si no tienes dominio propio
      to: email,
      subject: '¡Te han invitado a unirte al equipo!',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
          <h2 style="color: #2563eb;">Bienvenido a la plataforma</h2>
          <p>Has sido invitado a unirte a nuestro Dashboard como <strong>${role || 'user'}</strong>.</p>
          <p>Para configurar tu cuenta, contraseña y foto, haz clic en el siguiente botón:</p>
          <a href="${inviteLink}" style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">Aceptar Invitación</a>
          <p style="margin-top: 20px; font-size: 12px; color: #666;">Si el botón no funciona, copia este enlace: ${inviteLink}</p>
        </div>
      `
    });

    res.status(201).json({
      message: `Invitación enviada correctamente a ${email}`,
      link: inviteLink 
    });

  } catch (error) {
    console.error("Error en inviteUser:", error);
    res.status(500).json({ message: 'Error al enviar la invitación. Verifica las credenciales.' });
  }
};

const completeProfile = async (req, res) => {
    const { token } = req.params;

    try {
        const user = await User.findOne({ invitationToken: token });

        if (!user) {
            return res.status(404).json({ message: 'Token inválido o expirado' });
        }

        if (req.file) {
            const result = await cloudinary.uploader.upload(req.file.path, {
                folder: "lms_avatars", 
                width: 300, 
                crop: "scale"
            });
            user.avatar = result.secure_url;
            fs.unlinkSync(req.file.path);
        }

        user.username = req.body.username || req.body.name; 

        if (req.body.password) {
            const salt = await bcrypt.genSalt(10);
            user.password = await bcrypt.hash(req.body.password, salt);
        }

        user.status = 'active';
        user.invitationToken = null; 

        const updatedUser = await user.save();

        res.json({
            _id: updatedUser._id,
            username: updatedUser.username,
            email: updatedUser.email,
            role: updatedUser.role,
            avatar: updatedUser.avatar,
            status: updatedUser.status
        });

    } catch (error) {
        console.error(error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ message: 'Error al completar el perfil' });
    }
};

const forgotPassword = async (req, res) => {
    const { email } = req.body;

    try {
        const user = await User.findOne({ email });

        if (!user) {
            return res.status(404).json({ message: "No existe cuenta con este correo" });
        }

        const resetToken = crypto.randomBytes(20).toString('hex');
        const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');

        user.resetPasswordToken = resetTokenHash;
        user.resetPasswordExpire = Date.now() + 3600000; 

        await user.save();

        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        const resetUrl = `${frontendUrl}/reset-password/${resetToken}`;

        // USANDO RESEND TAMBIÉN AQUÍ
        try {
            await resend.emails.send({
                from: 'alexpase32@gmail.com',
                to: user.email,
                subject: "Restablecer Contraseña",
                html: `
                  <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                    <h2 style="color: #2563eb;">Recuperación de Contraseña</h2>
                    <p>Has solicitado restablecer tu contraseña. Haz clic en el siguiente enlace:</p>
                    <a href="${resetUrl}" style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px 0;">Restablecer Contraseña</a>
                    <p style="font-size: 12px; color: #666;">Este enlace expirará en 1 hora.</p>
                  </div>
                `,
            });

            res.status(200).json({ message: "Correo de recuperación enviado" });
        } catch (error) {
            user.resetPasswordToken = undefined;
            user.resetPasswordExpire = undefined;
            await user.save();
            return res.status(500).json({ message: "Error al enviar el correo" });
        }

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const resetPassword = async (req, res) => {
    try {
        const resetTokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');

        const user = await User.findOne({
            resetPasswordToken: resetTokenHash,
            resetPasswordExpire: { $gt: Date.now() } 
        });

        if (!user) {
            return res.status(400).json({ message: "Token inválido o expirado" });
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(req.body.password, salt);

        user.resetPasswordToken = undefined;
        user.resetPasswordExpire = undefined;

        await user.save();

        res.status(200).json({ message: "Contraseña actualizada correctamente" });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = { registerUser, loginUser, getProfile, inviteUser, completeProfile, resetPassword, forgotPassword };