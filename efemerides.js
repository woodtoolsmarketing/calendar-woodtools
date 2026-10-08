/*
 * efemerides.js
 * Fechas imprescindibles que vienen cargadas por defecto en el calendario
 * (relacionadas a la UOM / industria metalúrgica).
 *
 * Por cada fecha se arman DOS tareas anuales (recurrence.freq = 'yearly'),
 * ambas de importancia TRASCENDENTAL (alerta a pantalla completa) a las 08:00:
 *   - "aviso": 4 días antes, para avisar que la fecha se acerca
 *   - "dia":   el día de la fecha, para anunciarla
 *
 * Son tareas normales (type:'task'): no publican nada, sólo recuerdan.
 * main.js las siembra una sola vez (seedBuiltinDates); si el usuario borra
 * alguna, no vuelve a aparecer (ver seededBuiltinIds en el store).
 */
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

// month es 1-based (1 = enero) para que se lea fácil.
const DATES = [
  { key: 'trabajador', month: 5, day: 1, emoji: '✊', name: 'Día del Trabajador', nota: 'Día Internacional del Trabajador.' },
  { key: 'industria', month: 9, day: 2, emoji: '🏭', name: 'Día de la Industria', nota: 'Día de la Industria Argentina (2 de septiembre).' },
  { key: 'metalurgico', month: 9, day: 7, emoji: '🔧', name: 'Día del Trabajador Metalúrgico', nota: 'Día del Trabajador Metalúrgico (UOM · CCT 260/75).' },
];

const DAYS_BEFORE = 4;
const HOUR = 8; // 08:00
const DURATION_MS = 30 * 60 * 1000;

function iso(year, monthIdx, day, hour) {
  // Fecha en hora LOCAL de la PC; el planificador compara en hora local.
  return new Date(year, monthIdx, day, hour, 0, 0, 0).toISOString();
}

// Construye las tareas imprescindibles. baseYear: año de anclaje (por defecto, el actual);
// como la recurrencia es anual, a partir de ese año se repiten para siempre.
function buildBuiltinTasks(baseYear) {
  const year = Number.isInteger(baseYear) ? baseYear : new Date().getFullYear();
  const tasks = [];

  for (const d of DATES) {
    const monthIdx = d.month - 1;
    const fechaLabel = `${d.day} de ${MESES[monthIdx]}`;

    // El día de la fecha
    const diaStart = iso(year, monthIdx, d.day, HOUR);
    tasks.push({
      id: `builtin-${d.key}-dia`,
      builtin: true,
      type: 'task',
      title: `${d.emoji} Hoy es el ${d.name}`,
      notes: `${d.nota}\nFecha imprescindible cargada por defecto.`,
      importance: 'TRASCENDENTAL',
      start: diaStart,
      end: new Date(new Date(diaStart).getTime() + DURATION_MS).toISOString(),
      recurrence: { freq: 'yearly' },
      firedKeys: [],
      doneOccurrences: [],
      status: 'pending',
    });

    // Aviso 4 días antes
    const avisoStart = iso(year, monthIdx, d.day - DAYS_BEFORE, HOUR);
    tasks.push({
      id: `builtin-${d.key}-aviso`,
      builtin: true,
      type: 'task',
      title: `${d.emoji} En ${DAYS_BEFORE} días: ${d.name} (${fechaLabel})`,
      notes: `Faltan ${DAYS_BEFORE} días para el ${d.name} (${fechaLabel}).\n${d.nota}`,
      importance: 'TRASCENDENTAL',
      start: avisoStart,
      end: new Date(new Date(avisoStart).getTime() + DURATION_MS).toISOString(),
      recurrence: { freq: 'yearly' },
      firedKeys: [],
      doneOccurrences: [],
      status: 'pending',
    });
  }

  return tasks;
}

module.exports = { buildBuiltinTasks, DATES };
