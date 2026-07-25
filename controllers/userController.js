const User = require('../models/User');
const cloudinary = require('../config/cloudinary');
const fs = require('fs'); // File System de Node para borrar archivos temporales
const { safeSearchRegex } = require('../middleware/security');
const { deleteUserCascade } = require('../services/userDeletionService');

// @desc    Actualizar perfil de usuario
// @route   PUT /api/users/profile
// @access  Privado
const updateUserProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ message: 'Usuario no encontrado' });
        }

        // 1. Si viene un archivo (imagen), subirlo a Cloudinary
        if (req.file) {
            const result = await cloudinary.uploader.upload(req.file.path, {
                folder: "lms_avatars", // Carpeta en Cloudinary
                width: 300, 
                crop: "scale"
            });
            
            // Guardamos la URL segura que nos da Cloudinary
            user.avatar = result.secure_url;
            
            // Borramos el archivo temporal del servidor para no llenarlo de basura
            fs.unlinkSync(req.file.path);
        }

        // 2. Actualizar otros datos si existen
        user.username = req.body.username || user.username;
        user.bio = req.body.bio || user.bio;
        // Si quisieras cambiar password, aquí iría la lógica también

        const updatedUser = await user.save();

        res.json({
            _id: updatedUser._id,
            username: updatedUser.username,
            email: updatedUser.email,
            role: updatedUser.role,
            avatar: updatedUser.avatar,
            bio: updatedUser.bio,
            token: req.body.token // Mantenemos el token si lo envían, o null
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al actualizar perfil' });
    }
};

const getAllUsers = async (req, res) => {
    try {
        const search = typeof req.query.search === 'string' ? req.query.search : '';
        const keyword = search
            ? {
                $or: [
                    { username: safeSearchRegex(search) },
                    { email: safeSearchRegex(search) },
                ],
            }
            : {};

        const users = await User.find(keyword).select('-password').limit(200); // No enviamos la contraseña
        res.json(users);
    } catch (error) {
        res.status(500).json({ message: "Error al obtener usuarios" });
    }
};

// 2. Cambiar Rol (Admin <-> User)
const updateUserRole = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (user) {
            user.role = req.body.role; // 'admin' o 'user'
            await user.save();
            res.json({ message: "Rol actualizado" });
        } else {
            res.status(404).json({ message: "Usuario no encontrado" });
        }
    } catch (error) {
        res.status(500).json({ message: "Error actualizando rol" });
    }
};

// 3. Eliminar Usuario (con limpieza en cascada)
// Cancela la suscripción en Stripe, anula comisiones asociadas, desvincula
// referidas y borra el contenido generado. Ver services/userDeletionService.js
const deleteUser = async (req, res) => {
    try {
        const targetId = req.params.id;

        // Protección: no borrarte a ti misma por accidente.
        if (String(targetId) === String(req.user._id)) {
            return res.status(400).json({ message: 'No puedes eliminar tu propia cuenta desde aquí.' });
        }

        const target = await User.findById(targetId).select('role email username');
        if (!target) return res.status(404).json({ message: 'Usuario no encontrado' });

        // Protección: no dejar la plataforma sin administradoras.
        if (target.role === 'admin') {
            const admins = await User.countDocuments({ role: 'admin' });
            if (admins <= 1) {
                return res.status(400).json({ message: 'No puedes eliminar a la única administradora.' });
            }
        }

        const result = await deleteUserCascade(targetId);
        if (!result.ok) {
            return res.status(404).json({ message: 'Usuario no encontrado' });
        }

        res.json({ message: 'Usuario eliminado', stats: result.stats });
    } catch (error) {
        console.error('deleteUser', error);
        res.status(500).json({ message: "Error eliminando usuario" });
    }
};

// GET /users/:id/public — perfil público de una alumna (visible para la comunidad).
// PRIVACIDAD: solo se exponen datos sociales. Nunca email, suscripción,
// comisiones, referidas ni nada financiero.
const getPublicProfile = async (req, res) => {
    try {
        const user = await User.findById(req.params.id)
            .select('username avatar bio role partnerLevel topAchievementTier topAchievementCode achievements currentStreak longestStreak createdAt status')
            .lean();

        if (!user || user.status !== 'active') {
            return res.status(404).json({ message: 'Perfil no encontrado' });
        }

        // Logros desbloqueados, enriquecidos con su definición del catálogo.
        const { achievements: catalog } = require('../config/achievementsConfig');
        const unlocked = (user.achievements || [])
            .map(a => {
                const def = catalog[a.code];
                if (!def) return null;
                return { code: a.code, title: def.title, icon: def.icon, tier: def.tier, unlockedAt: a.unlockedAt };
            })
            .filter(Boolean)
            .sort((a, b) => new Date(b.unlockedAt) - new Date(a.unlockedAt));

        // Actividad en la comunidad
        const Post = require('../models/Post');
        const QuizAttempt = require('../models/QuizAttempt');
        const [postsCount, coursesCompleted] = await Promise.all([
            Post.countDocuments({ author: user._id }),
            QuizAttempt.distinct('course', { user: user._id, passed: true })
        ]);

        res.json({
            _id: user._id,
            username: user.username,
            avatar: user.avatar,
            bio: user.bio || '',
            role: user.role,
            partnerLevel: user.partnerLevel || 1,
            topAchievementTier: user.topAchievementTier || null,
            currentStreak: user.currentStreak || 0,
            longestStreak: user.longestStreak || 0,
            memberSince: user.createdAt,
            achievements: unlocked,
            stats: {
                achievementsCount: unlocked.length,
                postsCount,
                coursesCompleted: coursesCompleted.length
            }
        });
    } catch (err) {
        console.error('getPublicProfile', err);
        res.status(500).json({ message: 'Error al cargar el perfil' });
    }
};

module.exports = { updateUserProfile, deleteUser, updateUserRole, getAllUsers, getPublicProfile };