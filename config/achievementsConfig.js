// Catálogo central de logros desbloqueables.
// `condition`: función llamada con (user, ctx) que retorna boolean.
// `auto`: si true, el sistema lo desbloquea solo cuando ocurre el ping.

module.exports = {
    achievements: {
        first_login:        { title: 'Primer paso',          icon: '🚀',  description: 'Iniciaste sesión por primera vez.' },
        streak_3:           { title: 'En racha',             icon: '🔥',  description: '3 días consecutivos entrando.' },
        streak_7:           { title: 'Imparable',            icon: '⚡',  description: '7 días consecutivos.' },
        streak_30:          { title: 'Hábito de Arquitecta', icon: '👑',  description: '30 días seguidos. Esto ya es estilo de vida.' },
        course_completed:   { title: 'Curso completado',     icon: '🎓',  description: 'Aprobaste un examen y completaste un curso.' },
        first_referral:     { title: 'Primera referida',     icon: '🤝',  description: 'Tu primera alumna referida se suscribió.' },
        first_commission:   { title: 'Primera comisión',     icon: '💰',  description: 'Recibiste tu primera comisión.' },
        ten_referrals:      { title: '10 referidas',         icon: '🌟',  description: 'Llevaste 10 alumnas a la plataforma.' },
        partner_activated:  { title: 'Partner activada',     icon: '✨',  description: 'Subiste a nivel Partner.' },
        first_post:         { title: 'Tu primera publicación', icon: '📣', description: 'Publicaste algo en el muro.' }
    }
};
