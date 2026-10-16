const Post = require('../models/Post');
const cloudinary = require('../config/cloudinary');
const { esImagen } = require('../config/upload');
const fs = require('fs');
// IMPORTAMOS EL HELPER DE NOTIFICACIONES
const { createNotificationInternal } = require('./notification.controller');
const { unlockAchievement, evaluateMilestones } = require('../services/engagementService');

// 1. Obtener todos los posts (El Feed)
const TABLEROS = ['muro', 'tareas', 'anuncios'];
// Solo las administradoras publican anuncios; el resto ve y comenta.
const SOLO_ADMIN = ['anuncios'];

const normalizarTablero = (valor) => {
    const t = String(valor || 'muro').toLowerCase();
    return TABLEROS.includes(t) ? t : 'muro';
};

const getPosts = async (req, res) => {
    try {
        // Sin filtro devolvería los tres tableros mezclados: un anuncio
        // aparecería en el muro y una entrega de tarea también.
        const board = normalizarTablero(req.query.board);

        // Las publicaciones creadas antes de existir los tableros no tienen el
        // campo `board`. Un filtro estricto las dejaría fuera y el muro
        // aparecería vacío tras desplegar, así que el muro también las recoge.
        const filtro = board === 'muro'
            ? { $or: [{ board: 'muro' }, { board: { $exists: false } }] }
            : { board };

        const posts = await Post.find(filtro)
            .sort({ createdAt: -1 })
            .populate('author', 'username avatar role partnerLevel topAchievementTier topAchievementCode')
            .populate('comments.user', 'username avatar topAchievementTier');

        res.json(posts);
    } catch (error) {
        res.status(500).json({ message: "Error al cargar el muro" });
    }
};

// 2. Crear Publicación
const createPost = async (req, res) => {
    try {
        const { content } = req.body;
        const board = normalizarTablero(req.body.board);

        // El permiso se comprueba en el servidor, no en la interfaz: ocultar el
        // formulario en el cliente no impide que alguien llame al endpoint.
        if (SOLO_ADMIN.includes(board) && req.user.role !== 'admin') {
            if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.status(403).json({ message: 'Solo el equipo puede publicar anuncios.' });
        }

        if (!String(content || '').trim() && !req.file) {
            return res.status(400).json({ message: 'Escribe algo o adjunta un archivo.' });
        }

        let imageUrl = '';
        let adjunto;

        if (req.file) {
            if (esImagen(req.file)) {
                // Las imágenes se optimizan y se muestran dentro de la publicación.
                const result = await cloudinary.uploader.upload(req.file.path, {
                    folder: "lms_posts",
                    width: 1200,
                    crop: "limit"
                });
                imageUrl = result.secure_url;
            } else {
                // Los documentos van como `raw`: si se suben como imagen,
                // Cloudinary intenta procesarlos y los corrompe.
                const result = await cloudinary.uploader.upload(req.file.path, {
                    folder: "lms_entregas",
                    resource_type: "raw",
                    use_filename: true,
                    unique_filename: true
                });
                adjunto = {
                    url: result.secure_url,
                    name: req.file.originalname,
                    mime: req.file.mimetype,
                    size: req.file.size
                };
            }
            fs.unlinkSync(req.file.path);
        }

        const newPost = new Post({
            board,
            content,
            image: imageUrl || undefined,
            attachment: adjunto,
            author: req.user._id
        });

        const savedPost = await newPost.save();
        await savedPost.populate('author', 'username avatar role partnerLevel topAchievementTier topAchievementCode');

        evaluateMilestones(req.user._id).catch(() => {});

        res.status(201).json(savedPost);
    } catch (error) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ message: "Error al publicar" });
    }
};

// 3. Dar / Quitar Like (Toggle)
const toggleLike = async (req, res) => {
    try {
        const post = await Post.findById(req.params.id);
        if (!post) return res.status(404).json({ message: "Post no encontrado" });

        const index = post.likes.indexOf(req.user._id);

        if (index === -1) {
            // --- DAR LIKE ---
            post.likes.push(req.user._id);

            // ---> NOTIFICACIÓN <---
            const io = req.app.get('socketio'); // Obtenemos la instancia de socket
            if (io) {
                await createNotificationInternal(io, {
                    recipientId: post.author, // Dueño del post
                    senderId: req.user._id,   // Quien da like
                    type: 'like',
                    content: `${req.user.username} le dio like a tu publicación`,
                    link: '/muro' // O la URL específica del post si la tuvieras
                });
            }
            // ---------------------

        } else {
            // --- QUITAR LIKE ---
            post.likes.splice(index, 1);
        }

        await post.save();
        res.json(post.likes);
    } catch (error) {
        console.error(error); // Bueno para depurar
        res.status(500).json({ message: "Error en el like" });
    }
};

// 4. Comentar
const addComment = async (req, res) => {
    try {
        const post = await Post.findById(req.params.id);
        if (!post) return res.status(404).json({ message: "Post no encontrado" });

        const newComment = {
            user: req.user._id,
            text: req.body.text
        };

        post.comments.push(newComment);
        await post.save();

        evaluateMilestones(req.user._id).catch(() => {});

        // ---> NOTIFICACIÓN <---
        const io = req.app.get('socketio');
        if (io) {
            await createNotificationInternal(io, {
                recipientId: post.author, // Dueño del post
                senderId: req.user._id,   // Quien comenta
                type: 'comment',
                content: `${req.user.username} comentó en tu publicación: "${req.body.text.substring(0, 20)}..."`,
                link: '/muro'
            });
        }
        // ---------------------

        const updatedPost = await Post.findById(req.params.id)
            .populate('comments.user', 'username avatar');

        res.json(updatedPost.comments);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error al comentar" });
    }
};

// 5. Eliminar Post
const deletePost = async (req, res) => {
    try {
        const post = await Post.findById(req.params.id);
        if (!post) return res.status(404).json({ message: "Post no encontrado" });

        if (post.author.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
            return res.status(401).json({ message: "No autorizado" });
        }

        await post.deleteOne();
        res.json({ message: "Publicación eliminada" });
    } catch (error) {
        res.status(500).json({ message: "Error al eliminar" });
    }
};

// Toggle de reacción tipada (heart/fire/muscle/clap/sparkles).
// Una alumna solo puede tener UNA reacción por post (la que toque cambia o quita).
const toggleReaction = async (req, res) => {
    try {
        const { id, type } = req.params;
        const ALLOWED = ['heart', 'fire', 'muscle', 'clap', 'sparkles'];
        if (!ALLOWED.includes(type)) {
            return res.status(400).json({ message: 'Reacción inválida' });
        }
        const post = await Post.findById(id);
        if (!post) return res.status(404).json({ message: 'Post no encontrado' });

        post.reactions = post.reactions || [];
        const myIdx = post.reactions.findIndex(r => r.user.toString() === req.user._id.toString());

        if (myIdx >= 0) {
            const current = post.reactions[myIdx];
            if (current.type === type) {
                // Misma reacción → toggle off
                post.reactions.splice(myIdx, 1);
            } else {
                // Cambiar a otra
                current.type = type;
                current.createdAt = new Date();
            }
        } else {
            post.reactions.push({ user: req.user._id, type, createdAt: new Date() });
        }

        await post.save();
        res.json({
            reactions: post.reactions,
            counts: post.reactions.reduce((acc, r) => { acc[r.type] = (acc[r.type] || 0) + 1; return acc; }, {}),
            myReaction: post.reactions.find(r => r.user.toString() === req.user._id.toString())?.type || null
        });
    } catch (err) {
        console.error('toggleReaction', err);
        res.status(500).json({ message: 'Error al reaccionar' });
    }
};

module.exports = { getPosts, createPost, toggleLike, addComment, deletePost, toggleReaction };