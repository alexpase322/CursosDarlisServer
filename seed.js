const mongoose = require('mongoose');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const User = require('./models/User');
const connectDB = require('./config/db');

dotenv.config();
connectDB();

const createAdmin = async () => {
    try {
        // 1. Verificar si ya existe un admin
        const adminExists = await User.findOne({ email: 'admin@admin.com' });
        
        if (adminExists) {
            console.log('⚠️ El administrador ya existe');
            process.exit();
        }

        // 2. Crear el hash del password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash('12345678', salt); // Contraseña inicial: 123456

        // 3. Crear el usuario Admin
        const adminUser = await User.create({
            username: 'Darlis Franco',
            email: 'admin@admin.com',
            password: hashedPassword,
            role: 'admin', // IMPORTANTE: Rol de admin
            avatar: 'https://cdn-icons-png.flaticon.com/512/3135/3135715.png'
        });

        console.log('✅ Administrador creado exitosamente');
        console.log('📧 Email: admin@admin.com');
        console.log('🔑 Pass: 123456');
        
        process.exit();
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        process.exit(1);
    }
};

createAdmin();