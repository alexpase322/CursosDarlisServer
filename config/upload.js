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

// --- Adjuntos de tareas ---
// Una entrega suele ser un PDF o un documento, no una foto. Se permite un
// conjunto cerrado y algo más de tamaño, pero nunca ejecutables ni scripts.
const MAX_ADJUNTO = 10 * 1024 * 1024; // 10 MB

const ADJUNTO_MIME = [
    ...ALLOWED_MIME,
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'application/zip',
    'application/x-zip-compressed'
];
const ADJUNTO_EXT = [...ALLOWED_EXT, '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.zip'];

const adjuntoFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    // Se exigen AMBOS: un .exe renombrado a .pdf falla el mimetype, y un pdf
    // con mimetype falseado falla la extensión.
    const ok = ADJUNTO_MIME.includes((file.mimetype || '').toLowerCase()) && ADJUNTO_EXT.includes(ext);
    if (ok) return cb(null, true);
    cb(new Error('Formato no permitido. Acepta imágenes, PDF, Word, Excel, PowerPoint, TXT o ZIP.'));
};

const adjuntoUpload = multer({
    dest: 'uploads/',
    limits: { fileSize: MAX_ADJUNTO, files: 1 },
    fileFilter: adjuntoFilter
});

const singleAttachment = (fieldName) => (req, res, next) => {
    adjuntoUpload.single(fieldName)(req, res, (err) => {
        if (err) {
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(413).json({ message: 'El archivo supera el límite de 10 MB.' });
                }
                return res.status(400).json({ message: 'Error al subir el archivo.' });
            }
            return res.status(400).json({ message: err.message || 'Archivo no permitido.' });
        }
        next();
    });
};

const esImagen = (file) => ALLOWED_MIME.includes((file?.mimetype || '').toLowerCase());

module.exports = { imageUpload, singleImage, singleAttachment, esImagen, MAX_SIZE, MAX_ADJUNTO };
