const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const courseRoutes = require('./routes/courseRoutes');
const postRoutes = require('./routes/post.routes')
const chatRoutes = require('./routes/chat.routes'); 
const notificationRoutes = require('./routes/notification.routes')
const paymentRoutes = require('./routes/payment.routes');
const { stripeWebhook } = require('./controllers/payment.controller'); 
const http = require('http'); 
const { Server } = require('socket.io'); 

// Configuración
dotenv.config();
connectDB();

const app = express();

// --- CORRECCIÓN AQUÍ: Lista de orígenes permitidos ---
// Esto permite que funcione en tu PC y en Vercel al mismo tiempo sin cambiar variables
const allowedOrigins = [
    "http://localhost:5173",
    "https://arquitectadetupropioexito.com/", 
    "https://arquitectadetupropioexito.com"
];

// O si prefieres usar la variable de entorno, asegúrate de que esté en la lista:
if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL);
}

// Webhook de Stripe (debe ir antes del express.json)
app.post('/payment/webhook', express.raw({ type: 'application/json' }), stripeWebhook);

// Middlewares
app.use(express.json()); 

// Configuración CORS para Express (Rutas normales)
app.use(cors({
    origin: function (origin, callback) {
        // Permitir peticiones sin origen (como Postman o Apps móviles) o si está en la lista
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.log("Origen bloqueado por CORS:", origin);
            callback(new Error('No permitido por CORS'));
        }
    },
    credentials: true
}));

const server = http.createServer(app);

// Configuración CORS para Socket.io (Chat y Notificaciones)
const io = new Server(server, {
    cors: {
        origin: allowedOrigins, // Usamos la misma lista
        methods: ["GET", "POST"],
        credentials: true
    }
})

app.set('socketio', io);

io.on("connection", (socket) => {
    console.log(`Usuario conectado: ${socket.id}`);

    socket.on("join_room", (conversationId) => {
        socket.join(conversationId);
        console.log(`Usuario ${socket.id} entró a la sala ${conversationId}`);
    });

    socket.on("send_message", (data) => {
        socket.to(data.conversationId).emit("receive_message", data.message);
    });

    socket.on("disconnect", () => {
        console.log("Usuario desconectado", socket.id);
    });
});

app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/courses', courseRoutes);
app.use('/posts', postRoutes);
app.use('/chat', chatRoutes); 
app.use('/notifications', notificationRoutes);
app.use('/payment', paymentRoutes);

app.get('/', (req, res) => {
    res.send('API de Plataforma de Cursos funcionando...');
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});