// ─────────────────────────────────────────────────────────────────────────────
// RANGOS DE ARQUITECTA (por comisiones generadas en USD, acumulado de por vida).
//
// A diferencia de los logros (que son muchos y se coleccionan), el rango es UNO
// solo y siempre visible: es el "título" que lleva la Arquitecta y que sube a
// medida que factura. Se muestra en el perfil, el muro y en una tarjeta
// descargable para compartir.
//
// La escalera sigue la metáfora de levantar una obra: del plano en papel al
// edificio que cambia el horizonte. Cada paleta refuerza el material de esa
// etapa (papel de plano → hormigón → piedra → ladrillo → oro → acero → vidrio
// → monumento), para que el ascenso también se vea, no solo se lea.
//
// El umbral se mide sobre el total histórico de comisiones NO anuladas
// (available + pending + paid), igual que el `totalEarnedUSD` del panel.
//
// Cada rango es un TÍTULO propio (Constructora, Urbanista, Leyenda…), no una
// frase: se muestra solo, sin prefijos. La escalera imita el ascenso dentro de
// un gremio de construcción, del aprendiz a la leyenda.
// ─────────────────────────────────────────────────────────────────────────────

const ranks = [
    {
        code: 'aprendiz',
        level: 0,
        minUSD: 0,
        title: 'Aprendiz',
        short: 'Aprendiz',
        lema: 'Toda obra grande empieza en el papel.',
        // Azul de plano arquitectónico.
        gradient: ['#0D2B4A', '#2C5F8D'],
        accent: '#BFE3FF',
        text: '#FFFFFF'
    },
    {
        code: 'constructora',
        level: 1,
        minUSD: 1000,
        title: 'Constructora',
        short: 'Constructora',
        lema: 'Pusiste la base. Ya nada te mueve.',
        // Hormigón y tierra excavada.
        gradient: ['#4A403A', '#8B7A6B'],
        accent: '#E8DDD0',
        text: '#FFFFFF'
    },
    {
        code: 'edificadora',
        level: 2,
        minUSD: 2000,
        title: 'Edificadora',
        short: 'Edificadora',
        lema: 'Tu estructura ya se sostiene sola.',
        // Piedra travertino.
        gradient: ['#6E6A5F', '#C4BBA8'],
        accent: '#FFFBF2',
        text: '#2B2822'
    },
    {
        code: 'maestra_de_obra',
        level: 3,
        minUSD: 5000,
        title: 'Maestra de Obra',
        short: 'Maestra de Obra',
        lema: 'Ya no levantas paredes: diriges la obra.',
        // Ladrillo cocido.
        gradient: ['#5C2318', '#B5542F'],
        accent: '#FFD9BC',
        text: '#FFFFFF'
    },
    {
        code: 'urbanista',
        level: 4,
        minUSD: 10000,
        title: 'Urbanista',
        short: 'Urbanista',
        lema: 'Dejaste de pensar en edificios. Piensas en ciudades.',
        // Cúpula dorada.
        gradient: ['#7A5A0B', '#E8C547'],
        accent: '#FFF6D4',
        text: '#3D2E00'
    },
    {
        code: 'visionaria',
        level: 5,
        minUSD: 25000,
        title: 'Visionaria',
        short: 'Visionaria',
        lema: 'Ves la obra terminada antes de poner el primer ladrillo.',
        // Acero y cielo de altura.
        gradient: ['#14293D', '#4E8FB8'],
        accent: '#D6EEFF',
        text: '#FFFFFF'
    },
    {
        code: 'titana',
        level: 6,
        minUSD: 50000,
        title: 'Titana',
        short: 'Titana',
        lema: 'Construiste en altura. Muy pocas llegan aquí.',
        // Vidrio espejado.
        gradient: ['#0B1F2A', '#3FA9A0'],
        accent: '#C9FFF6',
        text: '#FFFFFF'
    },
    {
        code: 'leyenda',
        level: 7,
        minUSD: 100000,
        title: 'Leyenda',
        short: 'Leyenda',
        lema: 'Cambiaste el horizonte. Tu nombre queda en la casa.',
        // Monumento: negro y oro.
        gradient: ['#111014', '#C9A227'],
        accent: '#FFEFB0',
        text: '#FFFFFF'
    }
];

const byCode = Object.fromEntries(ranks.map(r => [r.code, r]));

// Rango que corresponde a un total facturado. Siempre devuelve uno (el piso es
// nivel 0 con minUSD 0), así que nunca hay que manejar el caso null.
function rankForAmount(totalUSD) {
    const monto = Number(totalUSD) || 0;
    let actual = ranks[0];
    for (const r of ranks) {
        if (monto >= r.minUSD) actual = r;
        else break;
    }
    return actual;
}

const nextRank = (code) => ranks.find(r => r.level === (byCode[code]?.level ?? -1) + 1) || null;

// Progreso hacia el siguiente rango, listo para pintar una barra.
function rankProgress(totalUSD) {
    const monto = Number(totalUSD) || 0;
    const current = rankForAmount(monto);
    const next = nextRank(current.code);

    if (!next) {
        return { current, next: null, percent: 100, remainingUSD: 0 };
    }

    const tramo = next.minUSD - current.minUSD;
    const avance = monto - current.minUSD;
    return {
        current,
        next,
        percent: tramo > 0 ? Math.min(100, Math.max(0, +((avance / tramo) * 100).toFixed(1))) : 0,
        remainingUSD: +Math.max(0, next.minUSD - monto).toFixed(2)
    };
}

module.exports = { ranks, byCode, rankForAmount, nextRank, rankProgress };
