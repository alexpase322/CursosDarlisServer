const Post = require('../models/Post');
const cloudinary = require('../config/cloudinary');
const fs = require('fs');
// IMPORTAMOS EL HELPER DE NOTIFICACIONES
const { createNotificationInternal } = require('./notification.controller');

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

module.exports = { getPosts, createPost, toggleLike, addComment, deletePost };