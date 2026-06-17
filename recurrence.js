/*
 * recurrence.js
 * Lógica de recurrencia compartida entre el proceso principal (Electron/main)
 * y el renderer (calendario). Se carga con require() en main y con <script> en
 * el renderer (donde queda en window.Recurrence).
 *
 * Recurrencias soportadas: none | daily | weekly | monthly
 */
(function (global) {
  function pad(n) { return String(n).padStart(2, '0'); }

  // Clave de día local YYYY-MM-DD (sin zona horaria, para comparar ocurrencias)
  function dayKey(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  }

  // Devuelve la duración de la tarea en milisegundos (default 30 min)
  function durationMs(task) {
    if (task.start && task.end) {
      const ms = new Date(task.end) - new Date(task.start);
      if (ms > 0) return ms;
    }
    return 30 * 60 * 1000;
  }

  // ¿La tarea ocurre en la fecha "date"? Devuelve un Date con la hora correcta o null.
  function occurrenceOn(task, date) {
    const base = new Date(task.start);
    const baseDay = startOfDay(base);
    const target = startOfDay(date);

    // Nunca antes del inicio
    if (target < baseDay) return null;

    const freq = (task.recurrence && task.recurrence.freq) || 'none';

    let matches = false;
    if (freq === 'none') {
      matches = dayKey(base) === dayKey(date);
    } else if (freq === 'daily') {
      matches = true;
    } else if (freq === 'weekly') {
      matches = base.getDay() === date.getDay();
    } else if (freq === 'monthly') {
      matches = base.getDate() === date.getDate();
    }
    if (!matches) return null;

    // ¿Pasó la fecha de fin de la recurrencia?
    if (task.recurrence && task.recurrence.until) {
      const until = startOfDay(new Date(task.recurrence.until));
      if (target > until) return null;
    }

    return new Date(
      date.getFullYear(), date.getMonth(), date.getDate(),
      base.getHours(), base.getMinutes(), 0, 0
    );
  }

  // Expande una tarea en ocurrencias concretas dentro de [rangeStart, rangeEnd)
  function expandTask(task, rangeStart, rangeEnd) {
    const out = [];
    const freq = (task.recurrence && task.recurrence.freq) || 'none';

    if (freq === 'none') {
      const s = new Date(task.start);
      if (s >= rangeStart && s < rangeEnd) {
        out.push(buildInstance(task, s));
      }
      return out;
    }

    // Recorre día por día el rango visible
    let cursor = startOfDay(rangeStart);
    const guard = startOfDay(rangeEnd);
    let safety = 0;
    while (cursor < guard && safety < 800) {
      safety++;
      const occ = occurrenceOn(task, cursor);
      if (occ) out.push(buildInstance(task, occ));
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }
    return out;
  }

  function buildInstance(task, startDate) {
    const start = new Date(startDate);
    const end = new Date(start.getTime() + durationMs(task));
    const occKey = dayKey(start);
    const done = isOccurrenceDone(task, occKey);
    return {
      occKey,
      start,
      end,
      done,
    };
  }

  function isOccurrenceDone(task, occKey) {
    if (task.recurrence && task.recurrence.freq && task.recurrence.freq !== 'none') {
      return Array.isArray(task.doneOccurrences) && task.doneOccurrences.includes(occKey);
    }
    return task.status === 'done';
  }

  const api = {
    dayKey,
    startOfDay,
    durationMs,
    occurrenceOn,
    expandTask,
    isOccurrenceDone,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.Recurrence = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
