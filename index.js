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
const affiliateRoutes = require('./routes/affiliate.routes');
const adminCrmRoutes = require('./routes/admin.crm.routes');
const pushRoutes = require('./routes/push.routes');
const courseProgressRoutes = require('./routes/courseProgress.routes');
const quizRoutes = require('./routes/quiz.routes');
const leaderboardRoutes = require('./routes/leaderboard.routes');
const engagementRoutes = require('./routes/engagement.routes');
const webinarRoutes = require('./routes/webinar.routes');
const promosRoutes = require('./routes/promos.routes');
const testimonialRoutes = require('./routes/testimonial.routes');
const { stripeWebhook } = require('./controllers/payment.controller');
const { ensureStripeWebhook } = require('./services/stripeWebhookSetup');
const { runReminderJob } = require('./services/reminderService');
const { checkExpiredManualSubs } = require('./services/manualSubsService');
const cron = require('node-cron');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const { mongoSanitize, generalLimiter, authLimiter, publicFormLimiter } = require('./middleware/security');

// Configuración
dotenv.config();
connectDB();

const app = express();

// Detrás de proxy (Render/Railway/Vercel): confía en 1 salto para leer el IP real
// (necesario para que el rate-limit funcione por IP y no por el IP del proxy).
app.set('trust proxy', 1);

// Cabeceras de seguridad HTTP (XSS, clickjacking, sniffing, etc.)
// crossOriginResourcePolicy en 'cross-origin' para no romper imágenes/CDN.
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false // la CSP la maneja el frontend/host; evitamos romper el API
}));

// --- CORRECCIÓN AQUÍ: Lista de orígenes permitidos ---
// Esto permite que funcione en tu PC y en Vercel al mismo tiempo sin cambiar variables
const allowedOrigins = [
    "http://localhost:5173",
    "https://arquitectadetupropioexito.com",
    "https://www.arquitectadetupropioexito.com"
];

// O si prefieres usar la variable de entorno, asegúrate de que esté en la lista:
if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL);
}

// Webhook de Stripe (debe ir antes del express.json, con límite propio)
app.post('/payment/webhook', express.raw({ type: 'application/json', limit: '1mb' }), stripeWebhook);

// Middlewares — límite explícito de tamaño de payload (anti-DoS por body gigante)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Sanitización NoSQL: elimina operadores $/. de body, query y params.
app.use(mongoSanitize);

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

// Rate limit general para toda la API.
app.use(generalLimiter);

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

const Conversation = require('./models/Chat'); // Chat.js exporta el modelo 'Conversation'

// Auth del socket: exige un JWT válido en el handshake (socket.handshake.auth.token).
// Sin token válido, no se permite la conexión → nadie anónimo puede espiar salas.
io.use((socket, next) => {
    try {
        const token = socket.handshake.auth && socket.handshake.auth.token;
        if (!token) return next(new Error('No autorizado'));
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = String(decoded.id);
        socket.userRole = decoded.role;
        next();
    } catch {
        next(new Error('Token inválido'));
    }
});

// Cache corto de membresía para no golpear Mongo en cada mensaje.
const membershipCache = new Map(); // `${userId}:${convId}` → { ok, exp }
async function isMember(userId, conversationId) {
    if (!conversationId || typeof conversationId !== 'string' || conversationId.length > 40) return false;
    const key = `${userId}:${conversationId}`;
    const cached = membershipCache.get(key);
    if (cached && cached.exp > Date.now()) return cached.ok;
    let ok = false;
    try {
        ok = !!(await Conversation.exists({ _id: conversationId, members: userId }));
    } catch {
        ok = false;
    }
    membershipCache.set(key, { ok, exp: Date.now() + 60 * 1000 }); // 1 min
    return ok;
}

io.on("connection", (socket) => {
    // El usuario siempre puede unirse a SU sala personal (notificaciones),
    // que es su propio _id. Lo hacemos automáticamente al conectar.
    socket.join(socket.userId);

    socket.on("join_room", async (roomId) => {
        if (typeof roomId !== 'string') return;
        // Sala personal propia (notificaciones): permitida.
        if (roomId === socket.userId) {
            socket.join(roomId);
            return;
        }
        // Sala de conversación: solo si es miembro.
        if (await isMember(socket.userId, roomId)) {
            socket.join(roomId);
        }
        // Si no, se ignora silenciosamente.
    });

    socket.on("send_message", async (data) => {
        const conversationId = data && data.conversationId;
        if (!(await isMember(socket.userId, conversationId))) return;

        const incoming = (data && data.message) || {};
        const text = typeof incoming.text === 'string' ? incoming.text.trim().slice(0, 2000) : '';
        if (!text) return;

        // Forzamos que el sender sea el usuario autenticado (anti-spoofing).
        const safeMessage = {
            sender: socket.userId,
            text,
            createdAt: Date.now()
        };
        socket.to(conversationId).emit("receive_message", safeMessage);
    });

    socket.on("disconnect", () => { /* noop */ });
});

// Rate limit estricto en autenticación (login/registro/reset) — anti fuerza bruta.
app.use('/auth', authLimiter, authRoutes);
app.use('/users', userRoutes);
app.use('/courses', courseRoutes);
app.use('/posts', postRoutes);
app.use('/chat', chatRoutes);
app.use('/notifications', notificationRoutes);
app.use('/payment', paymentRoutes);
app.use('/affiliate', affiliateRoutes);
app.use('/admin', adminCrmRoutes);
app.use('/push', pushRoutes);
app.use('/courses', courseProgressRoutes);
app.use('/quizzes', quizRoutes);
app.use('/leaderboard', leaderboardRoutes);
app.use('/engagement', engagementRoutes);
// Formularios públicos (webinar): anti-spam.
app.use('/webinar', publicFormLimiter, webinarRoutes);
app.use('/promos', promosRoutes);
app.use('/testimonials', testimonialRoutes);

app.get('/', (req, res) => {
    res.send('API de Plataforma de Cursos funcionando...');
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    // Asegura que el webhook de Stripe esté registrado con todos los eventos.
    // No bloquea el arranque si falla.
    ensureStripeWebhook().catch(err => console.error('[stripe-webhook-setup] uncaught:', err));

    // Cron diario de recordatorios — corre todos los días a las 14:00 UTC (9am COL).
    if (process.env.DISABLE_REMINDER_CRON !== '1') {
        cron.schedule('0 14 * * *', () => {
            runReminderJob().catch(err => console.error('[reminders] cron error:', err.message));
        }, { timezone: 'UTC' });
        console.log('🕐 Cron de recordatorios programado (14:00 UTC diario).');
    }

    // Cron diario de subs manuales — corre a las 13:00 UTC (8am COL) antes de los reminders.
    cron.schedule('0 13 * * *', () => {
        checkExpiredManualSubs().catch(err => console.error('[manual-subs] cron error:', err.message));
    }, { timezone: 'UTC' });
    console.log('🕐 Cron de subs manuales programado (13:00 UTC diario).');

    // Corrida inmediata al arranque para no esperar 24h.
    checkExpiredManualSubs().catch(err => console.error('[manual-subs] startup error:', err.message));
});