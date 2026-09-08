const Course = require('../models/Course');
const { preguntarStream, parsearLinea, estado, estaConfigurado, MAX_PREGUNTA } = require('../services/tutorService');

// Localiza la clase dentro del curso y devuelve el contexto que necesita la
// tutora. Se lee de Mongo y no de lo que manda el cliente: si el navegador
// enviara el contexto, cualquiera podría inventarse una clase y usar el modelo
// para lo que quisiera.
async function cargarContexto(courseId, lessonId) {
    const course = await Course.findById(courseId)
        .select('title description modules')
        .lean();
    if (!course) return null;

    for (const module of course.modules || []) {
        const lesson = (module.lessons || []).find(l => String(l._id) === String(lessonId));
        if (lesson) {
            return {
                course: { title: course.title, description: course.description },
                module: { title: module.title },
                lesson: {
                    title: lesson.title,
                    description: lesson.description,
                    resources: lesson.resources || []
                }
            };
        }
    }
    return null;
}

// POST /tutor/ask
// Responde en streaming (SSE): con un modelo local la respuesta completa puede
// tardar 20-30 segundos, y ver las palabras aparecer es la diferencia entre
// "va lento" y "está roto".
const ask = async (req, res) => {
    const { courseId, lessonId, question, history } = req.body || {};

    if (!courseId || !lessonId) {
        return res.status(400).json({ message: 'Falta la clase' });
    }
    const pregunta = typeof question === 'string' ? question.trim() : '';
    if (!pregunta) {
        return res.status(400).json({ message: 'Escribe tu pregunta' });
    }
    if (pregunta.length > MAX_PREGUNTA) {
        return res.status(400).json({ message: `La pregunta es muy larga (máximo ${MAX_PREGUNTA} caracteres)` });
    }
    if (!estaConfigurado()) {
        return res.status(503).json({ message: 'La tutora no está disponible por ahora.' });
    }

    const contexto = await cargarContexto(courseId, lessonId);
    if (!contexto) return res.status(404).json({ message: 'Clase no encontrada' });

    let upstream = null;
    try {
        const r = await preguntarStream({
            contexto,
            historial: Array.isArray(history) ? history : [],
            pregunta
        });
        upstream = r;
    } catch (err) {
        console.error('[tutor]', err.code || '', err.message);
        const mensajes = {
            TIMEOUT: 'La tutora tardó demasiado. Intenta con una pregunta más corta.',
            SIN_CONEXION: 'La tutora no está disponible en este momento. Inténtalo en unos minutos.',
            PROVEEDOR_ERROR: 'La tutora tuvo un problema al responder. Inténtalo de nuevo.',
            SIN_CUOTA: 'Ahora mismo hay muchas alumnas preguntando. Espera unos minutos y vuelve a intentarlo.'
        };
        return res.status(503).json({
            message: mensajes[err.code] || 'La tutora no está disponible ahora mismo.',
            // A las alumnas se les da el mensaje amable; a quien administra se
            // le da el error real del proveedor, que es lo único que sirve para
            // arreglarlo (modelo mal escrito, clave inválida, URL incorrecta…).
            ...(req.user?.role === 'admin' ? { detalle: err.message, codigo: err.code } : {})
        });
    }

    // A partir de aquí la respuesta ya está abierta: los errores se mandan
    // como evento SSE, no como código HTTP.
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // que ningún proxy acumule el stream
    res.flushHeaders?.();

    const enviar = (evento, datos) => {
        res.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`);
    };

    // Si la alumna cierra la pestaña, se corta la generación en vez de dejar
    // al modelo trabajando para nadie.
    let cerrado = false;
    req.on('close', () => {
        cerrado = true;
        try { upstream.res.body?.cancel?.(); } catch { /* noop */ }
    });

    try {
        const decoder = new TextDecoder();
        let resto = '';

        for await (const chunk of upstream.res.body) {
            if (cerrado) break;

            // Un chunk de red puede cortar una línea por la mitad; `resto`
            // guarda el trozo incompleto hasta que llegue su final.
            // El formato de cada línea depende del proveedor: de eso se ocupa
            // parsearLinea, aquí solo se reenvía lo que devuelve.
            resto += decoder.decode(chunk, { stream: true });
            const lineas = resto.split('\n');
            resto = lineas.pop() || '';

            for (const linea of lineas) {
                const { token, done, error } = parsearLinea(linea);

                if (error) {
                    enviar('error', { message: 'La tutora tuvo un problema al responder.' });
                    console.error('[tutor] error del proveedor:', error);
                    return res.end();
                }
                if (token) enviar('token', { t: token });
                if (done) {
                    enviar('done', {});
                    return res.end();
                }
            }
        }
        enviar('done', {});
        res.end();
    } catch (err) {
        console.error('[tutor] stream:', err.message);
        enviar('error', { message: 'Se cortó la respuesta. Inténtalo de nuevo.' });
        res.end();
    } finally {
        upstream.cancelar();
    }
};

// GET /tutor/available
// Lo consulta el widget al abrirse para saber si debe mostrarse. No llama al
// proveedor (sería lento y gastaría cuota): solo mira si hay configuración.
// Así, si el backend aún no tiene las variables, la alumna no ve un botón roto.
const available = (req, res) => {
    res.json({ available: estaConfigurado() });
};

// GET /tutor/health  → diagnóstico completo para el panel de admin.
// Además de listar modelos, hace una pregunta mínima de verdad: listar el
// catálogo puede salir bien y aun así fallar el chat (modelo retirado, clave sin
// permiso para generar, cuota agotada). Es el error de la prueba real el que
// dice qué arreglar.
const health = async (req, res) => {
    const base = await estado();

    let prueba = { intentada: false };
    if (base.ok) {
        try {
            const r = await preguntarStream({
                contexto: {
                    course: { title: 'Prueba', description: '' },
                    module: { title: 'Prueba' },
                    lesson: { title: 'Prueba', description: '', resources: [] }
                },
                historial: [],
                pregunta: 'Responde solo con la palabra OK.'
            });
            r.res.body?.cancel?.().catch?.(() => {});
            r.cancelar();
            prueba = { intentada: true, ok: true };
        } catch (err) {
            prueba = { intentada: true, ok: false, codigo: err.code, detalle: err.message };
        }
    }

    res.json({ ...base, ok: base.ok && (!prueba.intentada || prueba.ok === true), prueba });
};

module.exports = { ask, available, health };
