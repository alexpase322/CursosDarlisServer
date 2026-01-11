const jwt = require('jsonwebtoken');
const User = require('../models/User');

// 1. Proteger rutas (Verificar que esté logueado)
const protect = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            // Obtener el token del header (Bearer token123...)
            token = req.headers.authorization.split(' ')[1];

            // Verificar el token
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            // Buscar el usuario en la BD y agregarlo a la request (req.user)
            // .select('-password') quita la contraseña de los datos devueltos
            req.user = await User.findById(decoded.id).select('-password');

            next(); // Continuar a la siguiente función
        } catch (error) {
            console.error(error);
            res.status(401).json({ message: 'No autorizado, token fallido' });
        }
    }

    if (!token) {
        res.status(401).json({ message: 'No autorizado, no hay token' });
    }
};

// 2. Middleware de Admin (Verificar rol)
const admin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(401).json({ message: 'No autorizado como administrador' });
    }
};

module.exports = { protect, admin };