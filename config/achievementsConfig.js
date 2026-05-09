// Catálogo central de logros con sistema de tiers (bronze < silver < gold < diamond).
// El tier se usa para pintar el "marco" del avatar: la alumna lleva el color del logro
// más alto que tenga desbloqueado.

const TIERS = {
    bronze:  { rank: 1, color: '#CD7F32', glow: 'rgba(205,127,50,0.4)',  ring: 'ring-amber-700' },
    silver:  { rank: 2, color: '#A8A8A8', glow: 'rgba(168,168,168,0.5)', ring: 'ring-gray-400' },
    gold:    { rank: 3, color: '#D4AF37', glow: 'rgba(212,175,55,0.6)',  ring: 'ring-amber-400' },
    diamond: { rank: 4, color: '#5BC0EB', glow: 'rgba(91,192,235,0.7)',  ring: 'ring-cyan-400' }
};

const achievements = {
    // ───── Onboarding / hábito (escalable por racha) ─────
    first_login:        { tier: 'bronze',  title: 'Primer paso',          icon: '🚀',  description: 'Iniciaste sesión por primera vez.' },
    streak_3:           { tier: 'bronze',  title: 'En racha',             icon: '🔥',  description: '3 días consecutivos entrando.' },
    streak_7:           { tier: 'silver',  title: 'Imparable',            icon: '⚡',  description: '7 días consecutivos.' },
    streak_30:          { tier: 'gold',    title: 'Hábito de Arquitecta', icon: '👑',  description: '30 días seguidos.' },
    streak_60:          { tier: 'gold',    title: '2 meses al hilo',      icon: '🌋',  description: '60 días seguidos. Esto es disciplina.' },
    streak_100:         { tier: 'diamond', title: 'Leyenda viva',         icon: '💎',  description: '100 días seguidos. Eres una Arquitecta de élite.' },
    streak_365:         { tier: 'diamond', title: 'Un año contigo',       icon: '🏛️', description: 'Un año completo sin perder un día.' },
    full_week:          { tier: 'silver',  title: 'Semana completa',      icon: '📅',  description: 'Entraste 7 días dentro de la misma semana.' },

    // ───── Cursos completados ─────
    course_completed:   { tier: 'bronze',  title: 'Primer curso',         icon: '🎓',  description: 'Aprobaste tu primer examen y completaste un curso.' },
    five_courses:       { tier: 'silver',  title: 'Estudiante constante', icon: '📚',  description: 'Completaste 5 cursos.' },
    ten_courses:        { tier: 'gold',    title: 'Maestra del método',   icon: '🎯',  description: 'Completaste 10 cursos.' },
    twenty_courses:     { tier: 'diamond', title: 'Arquitecta certificada', icon: '🏆', description: 'Completaste 20 cursos. Dominas el método.' },

    // ───── Programa de afiliadas ─────
    first_referral:     { tier: 'bronze',  title: 'Primera referida',     icon: '🤝',  description: 'Tu primera alumna referida se suscribió.' },
    ten_referrals:      { tier: 'silver',  title: '10 referidas',         icon: '🌟',  description: 'Llevaste 10 alumnas a la plataforma.' },
    twenty_five_referrals: { tier: 'silver', title: '25 referidas',       icon: '✨',  description: 'Tu marca personal está despegando.' },
    fifty_referrals:    { tier: 'gold',    title: '50 referidas',         icon: '🌠',  description: 'Eres una conectora natural.' },
    hundred_referrals:  { tier: 'diamond', title: 'Top Closer · 100 referidas', icon: '👑', description: '100 alumnas confiaron en tu recomendación.' },
    partner_activated:  { tier: 'silver',  title: 'Partner activada',     icon: '✨',  description: 'Subiste a nivel Partner.' },
    partner_n3:         { tier: 'gold',    title: 'Seller Autorizada',    icon: '🎖️', description: 'Alcanzaste el nivel Seller Autorizada.' },
    partner_n4:         { tier: 'diamond', title: 'Closer Interna',       icon: '🏵️', description: 'El máximo nivel del programa.' },

    // ───── Comisiones (volumen) ─────
    first_commission:   { tier: 'bronze',  title: 'Primera comisión',     icon: '💰',  description: 'Recibiste tu primera comisión.' },
    five_commissions:   { tier: 'silver',  title: '5 comisiones',         icon: '💵',  description: 'Llevas 5 comisiones generadas.' },
    twenty_commissions: { tier: 'gold',    title: '20 comisiones',        icon: '💸',  description: 'Tu sistema de referidas funciona.' },
    fifty_commissions:  { tier: 'diamond', title: '50 comisiones',        icon: '🪙',  description: 'Esto ya es un canal de ingreso real.' },

    // ───── Comisiones (USD acumulado) ─────
    earned_100:         { tier: 'bronze',  title: '$100 generados',       icon: '💴',  description: 'Generaste tus primeros $100 USD en comisiones.' },
    earned_500:         { tier: 'silver',  title: '$500 generados',       icon: '💷',  description: 'Llevas $500 USD acumulados.' },
    earned_1000:        { tier: 'gold',    title: '$1.000 generados',     icon: '💶',  description: 'Cuatro cifras en comisiones.' },
    earned_5000:        { tier: 'diamond', title: '$5.000 generados',     icon: '🏅',  description: 'Top tier de generadoras de ingreso.' },

    // ───── Comunidad / muro ─────
    first_post:         { tier: 'bronze',  title: 'Tu primera publicación', icon: '📣', description: 'Publicaste algo en el muro.' },
    ten_posts:          { tier: 'silver',  title: 'Voz activa',           icon: '📢',  description: 'Publicaste 10 veces en el muro.' },
    fifty_posts:        { tier: 'gold',    title: 'Líder del muro',       icon: '🎤',  description: '50 publicaciones. Eres referente de la comunidad.' },
    first_comment:      { tier: 'bronze',  title: 'Conectada',            icon: '💬',  description: 'Comentaste por primera vez.' },
    fifty_comments:     { tier: 'silver',  title: 'Apoyas a tus colegas', icon: '🫶',  description: '50 comentarios. Sostienes la comunidad.' },

    // ───── Easter eggs (horario) ─────
    early_bird:         { tier: 'bronze',  title: 'Madrugadora',          icon: '🌅',  description: 'Entraste 5 veces antes de las 7am.' },
    night_owl:          { tier: 'bronze',  title: 'Búho nocturno',        icon: '🦉',  description: 'Entraste 5 veces después de las 11pm.' }
};

module.exports = { achievements, TIERS };
