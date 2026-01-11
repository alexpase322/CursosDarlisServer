const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const courseRoutes = require('./routes/courseRoutes');
const postRoutes = require('./routes/post.routes')
const chatRoutes = require('./routes/chat.routes'); // <--- NO OLVIDAR ESTA VEZ
const notificationRoutes = require('./routes/notification.routes')
const paymentRoutes = require('./routes/payment.routes');
const { stripeWebhook } = require('./controllers/payment.controller'); // Importar directo el controlador para la ruta raw
const http = require('http'); // 1. Importar HTTP
const { Server } = require('socket.io'); // 2. Importar Socket.io

// Configuración
dotenv.config();
connectDB();

const app = express();
app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), stripeWebhook);
// Middlewares
app.use(express.json()); // Para leer JSON
app.use(cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true
})); // Para permitir peticiones desde el Frontend

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:5173",
        methods: ["GET", "POST"]
    }
})

app.set('socketio', io);
io.on("connection", (socket) => {
    console.log(`Usuario conectado: ${socket.id}`);

    // Unirse a una sala específica (Conversation ID)
    socket.on("join_room", (conversationId) => {
        socket.join(conversationId);
        console.log(`Usuario ${socket.id} entró a la sala ${conversationId}`);
    });

    // Enviar mensaje
    socket.on("send_message", (data) => {
        // data debe tener: { conversationId, message }
        // Reenviamos el mensaje a todos en esa sala (incluyendo al remitente para confirmar o excluyéndolo)
        socket.to(data.conversationId).emit("receive_message", data.message);
    });

    socket.on("disconnect", () => {
        console.log("Usuario desconectado", socket.id);
    });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/chat', chatRoutes); 
app.use('/api/notifications', notificationRoutes);
app.use('/api/payment', paymentRoutes);



// Rutas de prueba
app.get('/', (req, res) => {
    res.send('API de Plataforma de Cursos funcionando...');
});

// Levantar servidor
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});