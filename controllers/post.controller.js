const Post = require('../models/Post');
const cloudinary = require('../config/cloudinary');
const fs = require('fs');
// IMPORTAMOS EL HELPER DE NOTIFICACIONES
const { createNotificationInternal } = require('./notification.controller');
const { unlockAchievement } = require('../services/engagementService');

// 1. Obtener todos los posts (El Feed)
const getPosts = async (req, res) => {
    try {
        const posts = await Post.find()
            .sort({ createdAt: -1 })
            .populate('author', 'username avatar role')
            .populate('comments.user', 'username avatar');

        res.json(posts);
    } catch (error) {
        res.status(500).json({ message: "Error al cargar el muro" });
    }
};

// 2. Crear Publicación
const createPost = async (req, res) => {
    try {
        const { content } = req.body;
        let imageUrl = '';

        if (req.file) {
            const result = await cloudinary.uploader.upload(req.file.path, {
                folder: "lms_posts",
                width: 800,
                crop: "limit"
            });
            imageUrl = result.secure_url;
            fs.unlinkSync(req.file.path);
        }

        const newPost = new Post({
            content,
            image: imageUrl || undefined,
            author: req.user._id
        });

        const savedPost = await newPost.save();
        await savedPost.populate('author', 'username avatar role');

        unlockAchievement(req.user._id, 'first_post').catch(() => {});

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