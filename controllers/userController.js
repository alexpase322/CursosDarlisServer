const User = require('../models/User');
const cloudinary = require('../config/cloudinary');
const fs = require('fs'); // File System de Node para borrar archivos temporales

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
        const keyword = req.query.search
            ? {
                $or: [
                    { username: { $regex: req.query.search, $options: "i" } },
                    { email: { $regex: req.query.search, $options: "i" } },
                ],
            }
            : {};

        const users = await User.find(keyword).select('-password'); // No enviamos la contraseña
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

// 3. Eliminar Usuario
const deleteUser = async (req, res) => {
    try {
        await User.findByIdAndDelete(req.params.id);
        res.json({ message: "Usuario eliminado" });
    } catch (error) {
        res.status(500).json({ message: "Error eliminando usuario" });
    }
};

module.exports = { updateUserProfile, deleteUser, updateUserRole, getAllUsers };