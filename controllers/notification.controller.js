const Notification = require('../models/Notification');

// Obtener mis notificaciones
const getNotifications = async (req, res) => {
    try {
        const notifications = await Notification.find({ recipient: req.user._id })
            .sort({ createdAt: -1 }) // Las más nuevas primero
            .populate('sender', 'username avatar') // Traer foto del que dio like/comentó
            .limit(20); // Solo las últimas 20
        res.json(notifications);
    } catch (error) {
        res.status(500).json({ message: "Error al obtener notificaciones" });
    }
};

// Marcar como leída (una o todas)
const markAsRead = async (req, res) => {
    try {
        // Si mandan ID, marca esa. Si no, marca todas.
        const filter = { recipient: req.user._id };
        if (req.params.id) filter._id = req.params.id;

        await Notification.updateMany(filter, { isRead: true });
        res.json({ message: "Notificaciones actualizadas" });
    } catch (error) {
        res.status(500).json({ message: "Error al actualizar" });
    }
};

// Función HELPER para crear notificaciones desde otros controladores (Post, Curso, etc.)
// No es un endpoint, es para usar internamente
const createNotificationInternal = async (io, { recipientId, senderId, type, content, link }) => {
    try {
        // No notificarse a uno mismo
        if (recipientId.toString() === senderId.toString()) return;

        const notif = await Notification.create({
            recipient: recipientId,
            sender: senderId,
            type,
            content,
            link
        });

        // Poblar sender para enviarlo por Socket bonito
        const populatedNotif = await notif.populate('sender', 'username avatar');

        // Emitir evento Socket en tiempo real a la sala del usuario
        // IMPORTANTE: El usuario debe unirse a una sala con su propio ID en el frontend
        io.to(recipientId.toString()).emit("new_notification", populatedNotif);

    } catch (error) {
        console.error("Error creando notificación:", error);
    }
};

module.exports = { getNotifications, markAsRead, createNotificationInternal };