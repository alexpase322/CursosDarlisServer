const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String },
    role: { 
        type: String, 
        enum: ['user', 'admin'], // Solo permite estos dos roles
        default: 'user' 
    },
    avatar: { 
        type: String, 
        default: 'https://res.cloudinary.com/demo/image/upload/v1578587614/sample.jpg' // Imagen por defecto
    },
    bio: { type: String, default: '' }, // Pequeña descripción para el perfil
    status: {
        type: String,
        enum: ["pending", "active"],
        default: "pending"
    },
    invitationToken: { type: String },
    resetPasswordToken: { type: String },
    resetPasswordExpire: { type: Date },
    subscription: {
        id: String, // ID de la suscripción en Stripe (sub_...)
        status: String, // active, past_due, canceled
        plan: String, // monthly, quarterly, yearly
        currentPeriodEnd: Date, // Cuándo se le acaba el acceso
        customerId: String // ID del cliente en Stripe (cus_...)
    }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);