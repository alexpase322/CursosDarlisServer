const Testimonial = require('../models/Testimonial');
const cloudinary = require('../config/cloudinary');
const fs = require('fs');
const { safeSearchRegex } = require('../middleware/security');

const AUTHOR_FIELDS = 'username avatar role partnerLevel topAchievementTier topAchievementCode';

// ─────────── ALUMNA / MIEMBRO ───────────

// GET /testimonials — lista de testimonios aprobados (comunidad)
const getTestimonials = async (req, res) => {
    try {
        const items = await Testimonial.find({ status: 'approved' })
            .sort({ featured: -1, createdAt: -1 })
            .populate('author', AUTHOR_FIELDS)
            .lean();
        res.json(items);
    } catch (err) {
        console.error('getTestimonials', err);
        res.status(500).json({ message: 'Error al cargar testimonios' });
    }
};

// GET /testimonials/me — mis testimonios
const getMyTestimonials = async (req, res) => {
    try {
        const items = await Testimonial.find({ author: req.user._id })
            .sort({ createdAt: -1 })
            .populate('author', AUTHOR_FIELDS)
            .lean();
        res.json(items);
    } catch (err) {
        console.error('getMyTestimonials', err);
        res.status(500).json({ message: 'Error al cargar tus testimonios' });
    }
};

// POST /testimonials — crear (multipart, imagen opcional)
const createTestimonial = async (req, res) => {
    try {
        const { content, rating } = req.body;
        if (!content || !content.trim()) {
            if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.status(400).json({ message: 'El testimonio no puede estar vacío' });
        }

        let imageUrl = '';
        if (req.file) {
            const result = await cloudinary.uploader.upload(req.file.path, {
                folder: 'lms_testimonials',
                width: 1000,
                crop: 'limit'
            });
            imageUrl = result.secure_url;
            fs.unlinkSync(req.file.path);
        }

        const r = parseInt(rating);
        const testimonial = await Testimonial.create({
            author: req.user._id,
            content: content.trim(),
            rating: Number.isFinite(r) ? Math.min(5, Math.max(1, r)) : 5,
            image: imageUrl || undefined
        });
        await testimonial.populate('author', AUTHOR_FIELDS);

        res.status(201).json(testimonial);
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error('createTestimonial', err);
        res.status(500).json({ message: 'Error al publicar el testimonio' });
    }
};

// DELETE /testimonials/:id — borrar (propio o admin)
const deleteTestimonial = async (req, res) => {
    try {
        const t = await Testimonial.findById(req.params.id);
        if (!t) return res.status(404).json({ message: 'Testimonio no encontrado' });

        const isOwner = t.author.toString() === req.user._id.toString();
        const isAdmin = req.user.role === 'admin';
        if (!isOwner && !isAdmin) {
            return res.status(403).json({ message: 'No autorizado' });
        }

        await t.deleteOne();
        res.json({ ok: true });
    } catch (err) {
        console.error('deleteTestimonial', err);
        res.status(500).json({ message: 'Error al eliminar' });
    }
};

// ─────────── PÚBLICO (landing) ───────────

// GET /testimonials/public/featured — destacados para la landing
const getFeaturedTestimonials = async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 12, 30);
        const items = await Testimonial.find({ status: 'approved', featured: true })
            .sort({ updatedAt: -1 })
            .limit(limit)
            .populate('author', 'username avatar')
            .lean();
        // Sólo exponemos lo necesario públicamente.
        res.json(items.map(t => ({
            _id: t._id,
            content: t.content,
            rating: t.rating,
            image: t.image || null,
            author: t.author ? { username: t.author.username, avatar: t.author.avatar } : null,
            createdAt: t.createdAt
        })));
    } catch (err) {
        console.error('getFeaturedTestimonials', err);
        res.json([]);
    }
};

// ─────────── ADMIN ───────────

// GET /testimonials/admin/all?status=&featured=&q=&page=&limit=
const adminListTestimonials = async (req, res) => {
    try {
        const { status, featured, q, page = 1, limit = 30 } = req.query;
        const filter = {};
        if (status) filter.status = status;
        if (featured === 'true') filter.featured = true;
        if (featured === 'false') filter.featured = false;
        if (q) filter.content = safeSearchRegex(q);

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [items, total, summary] = await Promise.all([
            Testimonial.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .populate('author', AUTHOR_FIELDS)
                .lean(),
            Testimonial.countDocuments(filter),
            Testimonial.aggregate([
                { $group: {
                    _id: null,
                    total: { $sum: 1 },
                    approved: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
                    hidden: { $sum: { $cond: [{ $eq: ['$status', 'hidden'] }, 1, 0] } },
                    featured: { $sum: { $cond: ['$featured', 1, 0] } }
                } }
            ])
        ]);

        res.json({
            items, total, page: parseInt(page), limit: parseInt(limit),
            summary: summary[0] || { total: 0, approved: 0, hidden: 0, featured: 0 }
        });
    } catch (err) {
        console.error('adminListTestimonials', err);
        res.status(500).json({ message: 'Error al listar testimonios' });
    }
};

// PATCH /testimonials/:id/feature  body: { featured: bool }
const toggleFeatured = async (req, res) => {
    try {
        const { featured } = req.body || {};
        const t = await Testimonial.findByIdAndUpdate(
            req.params.id,
            { $set: { featured: !!featured } },
            { new: true }
        );
        if (!t) return res.status(404).json({ message: 'No encontrado' });
        res.json({ ok: true, testimonial: t });
    } catch (err) {
        console.error('toggleFeatured', err);
        res.status(500).json({ message: 'Error al destacar' });
    }
};

// PATCH /testimonials/:id/status  body: { status: 'approved'|'hidden' }
const setStatus = async (req, res) => {
    try {
        const { status } = req.body || {};
        if (!['approved', 'hidden'].includes(status)) {
            return res.status(400).json({ message: 'Estado inválido' });
        }
        const t = await Testimonial.findByIdAndUpdate(
            req.params.id,
            { $set: { status } },
            { new: true }
        );
        if (!t) return res.status(404).json({ message: 'No encontrado' });
        res.json({ ok: true, testimonial: t });
    } catch (err) {
        console.error('setStatus', err);
        res.status(500).json({ message: 'Error al cambiar estado' });
    }
};

module.exports = {
    getTestimonials,
    getMyTestimonials,
    createTestimonial,
    deleteTestimonial,
    getFeaturedTestimonials,
    adminListTestimonials,
    toggleFeatured,
    setStatus
};
