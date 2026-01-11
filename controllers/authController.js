const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer'); // <--- IMPORTANTE
const cloudinary = require('../config/cloudinary'); 
const fs = require('fs');
const crypto = require('crypto');

// Generar Token JWT
const generateToken = (id, role) => {
    return jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465, // Puerto seguro SSL (funciona mejor en la nube)
  secure: true, // true para puerto 465, false para otros
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// @desc    Registrar nuevo usuario
// @route   POST /api/auth/register
const registerUser = async (req, res) => {
    const { username, email, password } = req.body;

    try {
        // 1. Verificar si ya existe
        const userExists = await User.findOne({ email });
        if (userExists) {
            return res.status(400).json({ message: 'El usuario ya existe' });
        }

        // 2. Encriptar contraseña
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // 3. Crear usuario
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
                token: generateToken(user.id, user.role), // Devolvemos el token inmediatamente
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
    // Como pasamos por el middleware 'protect', req.user ya tiene los datos
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

const inviteUser = async (req, res) => {
  const { email, role } = req.body;

  try {
    // 1. Verificar si ya existe
    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: 'El usuario ya existe' });
    }

    // 2. Generar token
    const token = crypto.randomBytes(20).toString('hex');

    // 3. Crear usuario "Pending"
    const user = await User.create({
      username: 'Usuario Pendiente', 
      email,
      role: role || 'user',
      status: 'pending',
      invitationToken: token
    });

    // 4. Generar Link (Usamos la variable de entorno o fallback a localhost)
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const inviteLink = `${frontendUrl}/setup-account/${token}`;

    // 5. ENVIAR EL CORREO (Lógica nueva)
    const mailOptions = {
      from: `"Admin del Sistema" <${process.env.EMAIL_USER}>`, // Remitente
      to: email, // Destinatario (el que escribiste en el input)
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
    };

    // Esperamos a que se envíe el correo
    await transporter.sendMail(mailOptions);

    res.status(201).json({
      message: `Invitación enviada correctamente a ${email}`,
      link: inviteLink // (Opcional) Lo dejamos por si quieres probar sin correo en dev
    });

  } catch (error) {
    console.error("Error en inviteUser:", error);
    
    // Si falla el correo, podrías querer borrar el usuario creado para que se pueda intentar de nuevo
    // await User.deleteOne({ email }); 

    res.status(500).json({ message: 'Error al enviar la invitación. Revisa las credenciales de correo.' });
  }
};

// @desc    Usuario completa su registro con el token
// @route   POST /api/auth/complete-profile
const completeProfile = async (req, res) => {
    const { token } = req.params;

    try {
        // 1. Buscamos usuario por el token (única diferencia con updateProfile)
        const user = await User.findOne({ invitationToken: token });

        if (!user) {
            return res.status(404).json({ message: 'Token inválido o expirado' });
        }

        // ======================================================
        // LÓGICA DE FOTO (COPIA EXACTA DE TU UPDATEPROFILE)
        // ======================================================
        if (req.file) {
            const result = await cloudinary.uploader.upload(req.file.path, {
                folder: "lms_avatars", 
                width: 300, 
                crop: "scale"
            });
            
            // Guardamos la URL segura que nos da Cloudinary
            user.avatar = result.secure_url;
            
            // Borramos el archivo temporal del servidor
            fs.unlinkSync(req.file.path);
        }
        // ======================================================

        // 2. Actualizar datos de registro (Nombre y Password)
        // Recibimos 'name' o 'username' del formulario
        user.username = req.body.username || req.body.name; 

        // Encriptamos la contraseña (esto es obligatorio aquí)
        if (req.body.password) {
            const salt = await bcrypt.genSalt(10);
            user.password = await bcrypt.hash(req.body.password, salt);
        }

        // 3. Activar usuario
        user.status = 'active';
        user.invitationToken = null; // Quemamos el token

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
        // Safety check: borrar archivo si algo falló
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
            // Por seguridad, a veces se dice "Si el correo existe, se envió el link"
            return res.status(404).json({ message: "No existe cuenta con este correo" });
        }

        // 1. Generar Token de Reseteo (simple, sin JWT para esto, solo crypto)
        const resetToken = crypto.randomBytes(20).toString('hex');

        // 2. Hash del token para guardar en BD (Seguridad extra)
        // Opcional: Puedes guardarlo plano si es un MVP, pero usemos hash simple
        const resetTokenHash = crypto
            .createHash('sha256')
            .update(resetToken)
            .digest('hex');

        // 3. Guardar token y expiración (1 hora = 3600000 ms)
        user.resetPasswordToken = resetTokenHash;
        user.resetPasswordExpire = Date.now() + 3600000; 

        await user.save();

        // 4. Crear Link de Frontend
        // IMPORTANTE: Esta ruta '/reset-password/:token' la crearemos luego en React
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        const resetUrl = `${frontendUrl}/reset-password/${resetToken}`;

        // 5. Enviar Email
        const message = `
          <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
            <h2 style="color: #2563eb;">Recuperación de Contraseña</h2>
            <p>Has solicitado restablecer tu contraseña. Haz clic en el siguiente enlace:</p>
            <a href="${resetUrl}" style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px 0;">Restablecer Contraseña</a>
            <p style="font-size: 12px; color: #666;">Este enlace expirará en 1 hora.</p>
            <p style="font-size: 12px; color: #666;">Si no solicitaste esto, ignora este correo.</p>
          </div>
        `;

        try {
            await transporter.sendMail({
                from: `"Soporte MomsDigitales" <${process.env.EMAIL_USER}>`,
                to: user.email,
                subject: "Restablecer Contraseña",
                html: message,
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

// @desc    Establecer nueva contraseña
// @route   PUT /api/auth/reset-password/:token
const resetPassword = async (req, res) => {
    try {
        // 1. Obtener el token de la URL y hashearlo igual que cuando lo guardamos
        const resetTokenHash = crypto
            .createHash('sha256')
            .update(req.params.token)
            .digest('hex');

        // 2. Buscar usuario que tenga ese token Y que no haya expirado
        const user = await User.findOne({
            resetPasswordToken: resetTokenHash,
            resetPasswordExpire: { $gt: Date.now() } // $gt = Greater Than (Mayor que ahora)
        });

        if (!user) {
            return res.status(400).json({ message: "Token inválido o expirado" });
        }

        // 3. Setear nueva password
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(req.body.password, salt);

        // 4. Limpiar campos de reseteo
        user.resetPasswordToken = undefined;
        user.resetPasswordExpire = undefined;

        await user.save();

        res.status(200).json({ message: "Contraseña actualizada correctamente" });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = { registerUser, loginUser, getProfile, inviteUser, completeProfile, resetPassword, forgotPassword };