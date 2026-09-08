// ─────────────────────────────────────────────────────────────────────────────
// Tutora IA de la clase.
//
// Habla con el proveedor de IA configurado (tu Ollama propio, o cualquier
// servicio compatible con OpenAI). El navegador NUNCA llama al proveedor
// directamente: si lo hiciera, la clave o la URL quedarían publicadas en el
// bundle. Todo pasa por aquí, que además es donde se inyecta el contexto de la
// clase y se controla el gasto.
// ─────────────────────────────────────────────────────────────────────────────

// Dos dialectos posibles:
//   'ollama' → tu servidor propio, endpoint /api/chat
//   'openai' → CUALQUIER proveedor compatible con OpenAI: Groq, OpenRouter,
//              Together, DeepSeek, vLLM… todos usan /v1/chat/completions.
// Se elige con TUTOR_PROVIDER. El resto del archivo no distingue: así cambiar
// de proveedor (o caer a uno de respaldo) es tocar variables, no código.
const PROVIDER = (process.env.TUTOR_PROVIDER || 'ollama').toLowerCase();
const ES_OPENAI = PROVIDER === 'openai';

const OLLAMA_URL = (process.env.OLLAMA_URL || '').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1';
const OLLAMA_TOKEN = process.env.OLLAMA_TOKEN || '';

const AI_BASE_URL = (process.env.AI_BASE_URL || '').replace(/\/+$/, '');
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || '';

const BASE = ES_OPENAI ? AI_BASE_URL : OLLAMA_URL;
const MODELO = ES_OPENAI ? AI_MODEL : OLLAMA_MODEL;

// Un modelo local puede tardar. 90s es generoso pero acotado: sin límite, una
// petición colgada se comería un worker de Render indefinidamente.
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 90000);

// Cuántos mensajes previos se reenvían. Más historial = más contexto pero
// respuestas más lentas y más VRAM. 8 cubre una conversación normal.
const MAX_HISTORIAL = 8;
const MAX_PREGUNTA = 1000;

const estaConfigurado = () => !!BASE && (!ES_OPENAI || (!!AI_API_KEY && !!AI_MODEL));

/**
 * Prompt de sistema: ancla a la tutora en ESTA clase concreta.
 * El contexto va aquí y no en el mensaje de la alumna para que ella no pueda
 * sobrescribirlo escribiendo "olvida las instrucciones anteriores".
 */
function construirSystem({ course, module, lesson }) {
    const recursos = (lesson.resources || [])
        .map(r => `- ${r.label}`)
        .join('\n');

    return [
        'Eres la tutora de "Arquitecta de tu Propio Éxito", una formación para mujeres emprendedoras de Latinoamérica.',
        'Acompañas a una alumna que está viendo una clase concreta y te hace preguntas sobre ella.',
        '',
        'CONTEXTO DE LA CLASE:',
        `Curso: ${course.title}`,
        course.description ? `Sobre el curso: ${course.description}` : '',
        `Módulo: ${module.title}`,
        `Clase: ${lesson.title}`,
        lesson.description ? `Contenido de la clase: ${lesson.description}` : '',
        recursos ? `Materiales disponibles en esta clase:\n${recursos}` : '',
        '',
        'CÓMO RESPONDER:',
        '- En español, tuteando, con calidez pero sin rodeos ni palabrería.',
        '- Concreta: 2 o 3 párrafos como máximo, salvo que te pida más detalle.',
        '- Apóyate en el contenido de la clase. Si la pregunta se sale de ahí,',
        '  respóndela igual si puedes ayudar, pero dile que ese tema se ve en otra parte.',
        '- No te inventes datos del curso: si no sabes si algo está en el temario,',
        '  dilo y sugiérele preguntarle a Darlis o al equipo.',
        '- Nada de precios, pagos, comisiones ni temas de cuenta: para eso, soporte.',
        '- No uses encabezados de markdown; texto corrido y, si acaso, viñetas simples.'
    ].filter(Boolean).join('\n');
}

/**
 * Lee una línea del stream y la normaliza, sea cual sea el proveedor.
 *   Ollama → NDJSON:  {"message":{"content":"Hola"},"done":false}
 *   OpenAI → SSE:     data: {"choices":[{"delta":{"content":"Hola"}}]}
 * Devuelve { token, done, error }; el controlador no necesita saber cuál es.
 */
function parsearLinea(linea) {
    let texto = linea.trim();
    if (!texto) return {};

    if (ES_OPENAI) {
        if (!texto.startsWith('data:')) return {};
        texto = texto.slice(5).trim();
        if (texto === '[DONE]') return { done: true };
    }

    let obj;
    try { obj = JSON.parse(texto); } catch { return {}; }

    if (obj.error) return { error: typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error) };

    return ES_OPENAI
        ? { token: obj.choices?.[0]?.delta?.content || '', done: !!obj.choices?.[0]?.finish_reason }
        : { token: obj.message?.content || '', done: !!obj.done };
}

/**
 * Pregunta al proveedor y devuelve el stream sin consumir, para que el
 * controlador lo vaya reenviando: la respuesta completa puede tardar 20-30s en
 * un modelo local, y ver las palabras aparecer es la diferencia entre "va
 * lento" y "está roto".
 */
async function preguntarStream({ contexto, historial = [], pregunta }) {
    if (!estaConfigurado()) {
        const e = new Error('La tutora IA no está configurada en el servidor');
        e.code = 'NO_CONFIGURADO';
        throw e;
    }

    const messages = [
        { role: 'system', content: construirSystem(contexto) },
        // Solo se aceptan los dos roles esperados: así un cliente manipulado no
        // puede colar un segundo "system" y saltarse las instrucciones.
        ...historial
            .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .slice(-MAX_HISTORIAL)
            .map(m => ({ role: m.role, content: m.content.slice(0, MAX_PREGUNTA) })),
        { role: 'user', content: pregunta.slice(0, MAX_PREGUNTA) }
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const res = await fetch(
            ES_OPENAI ? `${BASE}/chat/completions` : `${BASE}/api/chat`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(ES_OPENAI
                        ? { Authorization: `Bearer ${AI_API_KEY}` }
                        // Cabecera compartida con el túnel: sin esto, quien
                        // descubra la URL podría usar el modelo gratis.
                        : (OLLAMA_TOKEN ? { 'X-Tutor-Token': OLLAMA_TOKEN } : {}))
                },
                body: JSON.stringify(ES_OPENAI
                    ? { model: MODELO, messages, stream: true, temperature: 0.6, max_tokens: 700 }
                    : { model: MODELO, messages, stream: true, options: { temperature: 0.6, num_predict: 700 } }
                ),
                signal: controller.signal
            }
        );

        if (!res.ok) {
            const detalle = await res.text().catch(() => '');
            const e = new Error(`El proveedor de IA respondió ${res.status}: ${detalle.slice(0, 200)}`);
            // 429 = cuota de la capa gratuita agotada (por minuto o por día).
            // No es una avería: merece un mensaje distinto, porque se arregla
            // solo esperando y decirle "hubo un problema" la haría reintentar.
            e.code = res.status === 429 ? 'SIN_CUOTA' : 'PROVEEDOR_ERROR';
            e.reintentarEn = res.headers.get('retry-after') || null;
            throw e;
        }

        return { res, cancelar: () => clearTimeout(timer) };
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
            const e = new Error('La tutora tardó demasiado en responder');
            e.code = 'TIMEOUT';
            throw e;
        }
        if (err.code) throw err;
        // ECONNREFUSED, DNS, túnel caído…
        const e = new Error(`No se pudo contactar con la tutora: ${err.message}`);
        e.code = 'SIN_CONEXION';
        throw e;
    }
}

/** Comprueba que el proveedor responde y que el modelo existe. */
async function estado() {
    if (!estaConfigurado()) {
        return {
            ok: false,
            proveedor: PROVIDER,
            motivo: ES_OPENAI
                ? 'Faltan AI_BASE_URL, AI_API_KEY o AI_MODEL en las variables de entorno'
                : 'Falta OLLAMA_URL en las variables de entorno'
        };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await fetch(ES_OPENAI ? `${BASE}/models` : `${BASE}/api/tags`, {
            headers: ES_OPENAI
                ? { Authorization: `Bearer ${AI_API_KEY}` }
                : (OLLAMA_TOKEN ? { 'X-Tutor-Token': OLLAMA_TOKEN } : {}),
            signal: controller.signal
        });
        if (!res.ok) return { ok: false, proveedor: PROVIDER, motivo: `El proveedor respondió ${res.status}` };

        const data = await res.json();
        const modelos = ES_OPENAI
            ? (data.data || []).map(m => m.id)
            : (data.models || []).map(m => m.name);

        // Ollama etiqueta los modelos como "llama3.1:8b": se compara por prefijo
        // para no obligar a escribir la etiqueta exacta en el .env.
        const tieneModelo = modelos.some(n => n === MODELO || (!ES_OPENAI && n.startsWith(MODELO + ':')));

        return {
            ok: tieneModelo,
            proveedor: PROVIDER,
            modelo: MODELO,
            modelosDisponibles: modelos.slice(0, 40),
            motivo: tieneModelo ? null : `El modelo "${MODELO}" no aparece en la lista del proveedor`
        };
    } catch (err) {
        return {
            ok: false,
            proveedor: PROVIDER,
            motivo: err.name === 'AbortError'
                ? 'El proveedor de IA no respondió a tiempo'
                : `No se pudo contactar con el proveedor: ${err.message}`
        };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { preguntarStream, parsearLinea, estado, estaConfigurado, MAX_PREGUNTA };
