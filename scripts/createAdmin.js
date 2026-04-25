// Script para crear o promover un usuario admin.
// Uso:
//   node scripts/createAdmin.js <email> <password> [username]
// Ejemplos:
//   node scripts/createAdmin.js admin@dominio.com MiPassSegura123 "Darlis Admin"   (crea uno nuevo)
//   node scripts/createAdmin.js darlis@dominio.com NuevaPass123                     (si ya existe, lo promueve a admin y resetea password)
//
// Lee MONGO_URI del .env del server, así que ejecuta el script DESDE la carpeta /server.

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

(async () => {
    const [, , email, password, ...usernameParts] = process.argv;
    const username = usernameParts.join(' ').trim() || 'Admin';

    if (!email || !password) {
        console.error('Uso: node scripts/createAdmin.js <email> <password> [username]');
        process.exit(1);
    }

    if (!process.env.MONGO_URI) {
        console.error('Falta MONGO_URI en .env');
        process.exit(1);
    }

    try {
        await mongoose.connect(process.env.MONGO_URI);
        const hashed = await bcrypt.hash(password, 10);

        let user = await User.findOne({ email });
        if (user) {
            user.role = 'admin';
            user.status = 'active';
            user.password = hashed;
            if (usernameParts.length) user.username = username;
            await user.save();
            console.log(`✔ Usuario existente promovido a admin: ${user.email} (id: ${user._id})`);
        } else {
            user = await User.create({
                username,
                email,
                password: hashed,
                role: 'admin',
                status: 'active'
            });
            console.log(`✔ Admin creado: ${user.email} (id: ${user._id})`);
        }

        console.log('Ya puedes iniciar sesión con esas credenciales en /login.');
        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
})();
