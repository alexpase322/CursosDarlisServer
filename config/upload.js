// Configuración compartida de multer para subida de imágenes.
// Limita tamaño (5 MB) y valida el mimetype/extensión para no aceptar
// ejecutables ni archivos arbitrarios.

const multer = require('multer');
const path = require('path');

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif'];

const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mimeOk = ALLOWED_MIME.includes((file.mimetype || '').toLowerCase());
    const extOk = ALLOWED_EXT.includes(ext);
    if (mimeOk && extOk) return cb(null, true);
    cb(new Error('Solo se permiten imágenes (jpg, png, webp, gif, heic).'));
};

const imageUpload = multer({
    dest: 'uploads/',
    limits: { fileSize: MAX_SIZE, files: 1 },
    fileFilter
});

// Wrapper para .single() que traduce errores de multer a respuestas JSON limpias.
const singleImage = (fieldName) => (req, res, next) => {
    imageUpload.single(fieldName)(req, res, (err) => {
        if (err) {
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(413).json({ message: 'La imagen supera el límite de 5 MB.' });
                }
                return res.status(400).json({ message: 'Error al subir el archivo.' });
            }
            return res.status(400).json({ message: err.message || 'Archivo no permitido.' });
        }
        next();
    });
};

module.exports = { imageUpload, singleImage, MAX_SIZE };
