/* renderer.js — Lógica del calendario WoodTools */

const IMPORTANCE = {
  TRASCENDENTAL: { label: 'Trascendental', color: '#E84A6F' },
  IMPORTANTE: { label: 'Importante', color: '#2EC4B6' },
  PRESCINDIBLE: { label: 'Prescindible', color: '#B87333' },
};

// Plataformas de la pantalla de conexiones (clave del IPC → datos de UI)
const CONN_PLATFORMS = [
  { key: 'facebook', label: 'Facebook', icon: '📘' },
  { key: 'instagram', label: 'Instagram', icon: '📸' },
  { key: 'threads', label: 'Threads', icon: '🧵' },
  { key: 'youtube', label: 'YouTube', icon: '▶️' },
  { key: 'hosting', label: 'Cloudinary', icon: '🖼️' },
];

// Valores de respaldo mientras getAppInfo no respondió
const APP_INFO_FALLBACK = {
  privacyUrl: 'https://calendario-woodtools.onrender.com/privacy.html',
  termsUrl: 'https://calendario-woodtools.onrender.com/terms.html',
  dataDeletionUrl: 'https://calendario-woodtools.onrender.com/data-deletion.html',
  redirectUri: 'https://calendario-woodtools.onrender.com/oauth/callback.html',
  tiktokRedirectUri: 'http://127.0.0.1:8723/',
  facebookRedirectUri: 'https://www.facebook.com/connect/login_success.html',
  version: '',
};

const YT_PRIVACY_LABELS = { public: 'Público', unlisted: 'No listado', private: 'Privado' };
const YT_TITLE_MAX = 100;
const YT_DESC_MAX_BYTES = 5000;
const YT_SHORTS_SUFFIX = '\n\n#Shorts'; // estimación para el contador de bytes

const TIKTOK_PRIVACY_LABELS = {
  PUBLIC_TO_EVERYONE: 'Todos',
  MUTUAL_FOLLOW_FRIENDS: 'Amigos',
  FOLLOWER_OF_CREATOR: 'Seguidores',
  SELF_ONLY: 'Solo yo',
};
const TIKTOK_MUSIC_URL = 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';
const TIKTOK_BC_URL = 'https://www.tiktok.com/legal/page/global/bc-policy/en';

// Límites de texto del epígrafe (solo avisan, no bloquean)
const CAPTION_LIMITS = [['Threads', 500], ['Instagram', 2200], ['TikTok', 2200]];

// Extensiones de archivo (las mismas que aceptan youtube.js y tiktok.js)
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|avi|mkv|mpe?g|wmv|3gp)$/i;
const TIKTOK_VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;
const YOUTUBE_VIDEO_EXT = /\.(mp4|m4v|mov|webm|avi|mkv|mpe?g|wmv)$/i; // VIDEO_MIME de youtube.js
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif)$/i;
// YouTube programa (privado + fecha) solo si faltan más de 15 min, igual que youtube.js
const YT_SCHEDULE_MIN_AHEAD_MS = 15 * 60000;
// Red de la tarea → sección de ⚙ Conexiones
const PLATFORM_CONN_KEY = { Facebook: 'facebook', Instagram: 'instagram', Threads: 'threads', YouTube: 'youtube', TikTok: 'tiktok' };

let state = { tasks: [], templates: [] };
let calendar = null;
let editing = null;        // tarea en edición (o null si es nueva)
let editingOccKey = null;  // ocurrencia puntual seleccionada
let editingOverrides = {}; // cambios pendientes sobre la tarea (ej. Reprogramar)
let selectedMedia = null;  // { path, name } del archivo elegido
let selectedThumb = null;  // { path, name } de la miniatura/portada
let mediaDurationSec = null; // duración del video elegido (si se pudo leer)

let appInfo = { ...APP_INFO_FALLBACK };
let apiStatus = null;      // último STATUS_ALL recibido del proceso principal
let connViews = {};        // VIEW por plataforma (nunca trae secretos ni tokens)

// Estado del bloque de TikTok dentro del formulario
let tiktokComposer = {
  visible: false,
  reqId: 0,
  view: null,        // VIEW de TikTok (directPost / connected)
  viewReady: null,   // promesa de la consulta de la VIEW
  info: null,        // creator_info
  loaded: false,     // se cargaron las opciones de privacidad
  saved: null,       // task.tiktok guardado (al editar)
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// --------------------------------------------------------------------------
// Carga inicial
// --------------------------------------------------------------------------
async function load() {
  state = await window.api.getData();
  refreshTemplatesSelect();
  renderLists();
  if (calendar) calendar.refetchEvents();
  if (!$('#modal').hidden) renderFormPublishStatus();
}

window.api.onDataChanged(() => load());

// --------------------------------------------------------------------------
// Calendario (FullCalendar)
// --------------------------------------------------------------------------
function initCalendar() {
  const el = $('#calendar');
  calendar = new FullCalendar.Calendar(el, {
    initialView: 'dayGridMonth',
    locale: 'es',
    firstDay: 1,
    height: '100%',
    nowIndicator: true,
    scrollTime: '08:00:00',
    selectable: true,
    selectMirror: true,
    editable: true,
    dayMaxEvents: 3,
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek',
    },
    buttonText: { today: 'Hoy', month: 'Mes', week: 'Semana', day: 'Día', list: 'Lista' },
    events: provideEvents,
    dateClick: (info) => openForm({ date: info.date, allDay: info.allDay }),
    select: (info) => openForm({ date: info.start, end: info.end, allDay: info.allDay }),
    eventClick: (info) => {
      const { taskId, occKey } = info.event.extendedProps;
      const task = state.tasks.find((t) => t.id === taskId);
      if (task) openForm({ task, occKey });
    },
    eventDrop: (info) => applyDrag(info),
    eventResize: (info) => applyResize(info),
  });
  calendar.render();
}

// Expande tareas (incluyendo recurrentes) en eventos del rango visible
function provideEvents(fetchInfo, success) {
  const events = [];
  for (const task of state.tasks) {
    const instances = Recurrence.expandTask(task, fetchInfo.start, fetchInfo.end);
    for (const inst of instances) {
      const conf = IMPORTANCE[task.importance] || IMPORTANCE.PRESCINDIBLE;
      events.push({
        id: task.id + '::' + inst.occKey,
        title: (task.type === 'content' ? '📲 ' : '') + task.title,
        start: inst.start,
        end: inst.end,
        backgroundColor: conf.color,
        borderColor: conf.color,
        textColor: '#fff',
        classNames: inst.done ? ['is-done'] : [],
        extendedProps: { taskId: task.id, occKey: inst.occKey, importance: task.importance },
      });
    }
  }
  success(events);
}

function applyDrag(info) {
  const task = state.tasks.find((t) => t.id === info.event.extendedProps.taskId);
  if (!task) return;
  const ms = deltaMs(info.delta); // desplazamiento aplicado al arrastrar
  task.start = new Date(new Date(task.start).getTime() + ms).toISOString();
  if (task.end) task.end = new Date(new Date(task.end).getTime() + ms).toISOString();
  task.firedKeys = [];
  window.api.saveTask(task).then(() => load());
}

function applyResize(info) {
  const task = state.tasks.find((t) => t.id === info.event.extendedProps.taskId);
  if (!task) return;
  task.end = info.event.end.toISOString();
  window.api.saveTask(task).then(() => load());
}

function deltaMs(delta) {
  return (delta.years || 0) * 0 + (delta.months || 0) * 0 +
    (delta.days || 0) * 86400000 + (delta.milliseconds || 0);
}

// --------------------------------------------------------------------------
// Formulario / Modal
// --------------------------------------------------------------------------
function openForm({ date, end, task = null, occKey = null }) {
  editing = task;
  editingOccKey = occKey;
  editingOverrides = {};

  $('#modalTitle').textContent = task ? 'Editar tarea' : 'Nueva tarea';
  $('#fTemplate').value = '';

  if (task) {
    const occStart = occKey ? occKeyToDate(occKey, task) : new Date(task.start);
    $('#fTitle').value = task.title || '';
    setRadio('imp', task.importance || 'IMPORTANTE');
    $('#fDate').value = toDateInput(occStart);
    $('#fStart').value = toTimeInput(occStart);
    $('#fEnd').value = toTimeInput(new Date(occStart.getTime() + Recurrence.durationMs(task)));
    $('#fRecur').value = (task.recurrence && task.recurrence.freq) || 'none';
    const recurDays = (task.recurrence && task.recurrence.days) || [];
    $$('input[name="wday"]').forEach((c) => { c.checked = recurDays.includes(parseInt(c.value, 10)); });
    $('#fWeekdaysOnly').checked = false;
    $('#fNotes').value = task.notes || '';
    setRadio('ftype', task.type || 'task');
    // contenido
    $$('input[name="plat"]').forEach((c) => { c.checked = (task.platforms || []).includes(c.value); });
    $('#fContentType').value = task.contentType || 'Historia';
    setRadio('pubmode', task.publishMode || 'reminder');
    $('#fMediaUrl').value = task.mediaUrl || '';
    $('#fCaption').value = task.caption || '';
    $('#fLink').value = task.link || '';
    $('#fYtTitle').value = task.ytTitle || '';
    $('#fYtDescription').value = task.ytDescription || '';
    $('#fYtPrivacy').value = YT_PRIVACY_LABELS[task.ytPrivacy] ? task.ytPrivacy : 'public';
    $('#fYtShorts').checked = !!task.ytAddShortsTag;
    selectedMedia = task.mediaPath ? { path: task.mediaPath, name: task.mediaName || 'archivo' } : null;
    selectedThumb = task.thumbPath ? { path: task.thumbPath, name: task.thumbName || 'miniatura' } : null;
    tiktokComposer.saved = task.tiktok || null;
    $('#fStoryLink').checked = false;
    $('#fSaveTemplate').checked = false;
  } else {
    const d = date ? new Date(date) : new Date();
    if (!date) { d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0); }
    $('#fTitle').value = '';
    setRadio('imp', 'IMPORTANTE');
    $('#fDate').value = toDateInput(d);
    $('#fStart').value = toTimeInput(d);
    const e = end ? new Date(end) : new Date(d.getTime() + 30 * 60000);
    $('#fEnd').value = toTimeInput(e);
    $('#fRecur').value = 'none';
    $$('input[name="wday"]').forEach((c) => (c.checked = false));
    $('#fWeekdaysOnly').checked = false;
    $('#fNotes').value = '';
    setRadio('ftype', 'task');
    $$('input[name="plat"]').forEach((c) => (c.checked = false));
    $('#fContentType').value = 'Historia';
    setRadio('pubmode', 'reminder');
    $('#fMediaUrl').value = '';
    $('#fCaption').value = '';
    $('#fLink').value = '';
    $('#fYtTitle').value = '';
    $('#fYtDescription').value = '';
    $('#fYtPrivacy').value = 'public';
    $('#fYtShorts').checked = false;
    selectedMedia = null;
    selectedThumb = null;
    tiktokComposer.saved = null;
    $('#fStoryLink').checked = false;
    $('#fSaveTemplate').checked = false;
  }

  // El bloque de TikTok se vuelve a consultar cada vez que se abre
  tiktokComposer.visible = false;
  tiktokComposer.reqId++;
  tiktokComposer.view = null;
  tiktokComposer.viewReady = null;
  resetTiktokControls(tiktokComposer.saved);
  hideFormError();

  syncContentBlock();
  syncStoryLink();
  syncWeekDays();
  renderMediaName();
  renderThumbName();
  probeMediaDuration();
  syncAutoFields();
  renderFormPublishStatus();
  $('#btnDelete').hidden = !task;
  $('#btnDone').hidden = !task;
  $('#btnReschedule').hidden = !task;
  $('#modal').hidden = false;
  setTimeout(() => $('#fTitle').focus(), 50);
}

function closeForm() {
  $('#modal').hidden = true;
  editing = null;
  editingOccKey = null;
  editingOverrides = {};
  tiktokComposer.visible = false;
  tiktokComposer.reqId++;
  releaseTiktokPreview();
}

// Base para guardar: la versión más nueva de la tarea (el proceso principal
// puede haber anotado publicaciones mientras el formulario estaba abierto)
function editingBase() {
  if (!editing) return null;
  const fresh = state.tasks.find((t) => t.id === editing.id);
  return { ...(fresh || editing), ...editingOverrides };
}

function readForm() {
  const date = $('#fDate').value;
  const start = $('#fStart').value || '09:00';
  const end = $('#fEnd').value || '';
  const startDate = combine(date, start);
  let endDate = end ? combine(date, end) : new Date(startDate.getTime() + 30 * 60000);
  if (endDate <= startDate) endDate = new Date(startDate.getTime() + 30 * 60000);

  const type = getRadio('ftype');
  const base = editingBase();
  const task = base ? { ...base } : { id: uid(), firedKeys: [], doneOccurrences: [], status: 'pending' };
  task.title = $('#fTitle').value.trim();
  task.importance = getRadio('imp');
  task.start = startDate.toISOString();
  task.end = endDate.toISOString();
  task.notes = $('#fNotes').value.trim();
  task.type = type;
  const freq = $('#fRecur').value;
  if (freq === 'none') {
    task.recurrence = null;
  } else if (freq === 'weekly') {
    const days = $$('input[name="wday"]:checked').map((c) => parseInt(c.value, 10));
    task.recurrence = { freq: 'weekly', days };
  } else {
    task.recurrence = { freq };
  }

  if (type === 'content') {
    task.platforms = $$('input[name="plat"]:checked').map((c) => c.value);
    task.contentType = $('#fContentType').value;
    task.publishMode = getRadio('pubmode');
    task.mediaUrl = $('#fMediaUrl').value.trim();
    task.caption = $('#fCaption').value.trim();
    task.link = $('#fLink').value.trim();
    task.ytTitle = $('#fYtTitle').value.trim();
    task.ytDescription = $('#fYtDescription').value.trim();
    task.ytPrivacy = $('#fYtPrivacy').value || 'public';
    task.ytAddShortsTag = $('#fYtShorts').checked;
    const prevMediaPath = base ? base.mediaPath : undefined;
    const prevThumbPath = base ? base.thumbPath : undefined;
    if (selectedMedia) {
      task.mediaPath = selectedMedia.path;
      task.mediaName = selectedMedia.name;
    } else {
      delete task.mediaPath;
      delete task.mediaName;
    }
    if (selectedThumb) {
      task.thumbPath = selectedThumb.path;
      task.thumbName = selectedThumb.name;
    } else {
      delete task.thumbPath;
      delete task.thumbName;
    }
    // Si cambió el archivo, se olvidan los datos de hosting del anterior
    if (task.mediaPath !== prevMediaPath) {
      delete task.mediaKind;
      delete task.mediaInfo;
    }
    if (task.thumbPath !== prevThumbPath) delete task.thumbUrl;
    // Duración del video en segundos (medida acá; null si no hay video)
    if (task.mediaPath && VIDEO_EXT.test(task.mediaPath)) {
      if (Number.isFinite(mediaDurationSec) && mediaDurationSec > 0) {
        task.mediaDurationSec = Math.round(mediaDurationSec * 1000) / 1000;
      } else if (task.mediaPath !== prevMediaPath || !Number.isFinite(task.mediaDurationSec)) {
        task.mediaDurationSec = null;
      } // si no cambió el archivo, se conserva la duración guardada
    } else {
      task.mediaDurationSec = null;
    }
    if (task.platforms.includes('TikTok')) task.tiktok = readTiktokForm();
    else delete task.tiktok;
  } else {
    delete task.platforms;
    delete task.contentType;
    delete task.publishMode;
    delete task.mediaUrl;
    delete task.mediaKind;
    delete task.mediaInfo;
    delete task.caption;
    delete task.link;
    delete task.ytTitle;
    delete task.ytDescription;
    delete task.ytPrivacy;
    delete task.ytAddShortsTag;
    delete task.tiktok;
    delete task.mediaPath;
    delete task.mediaName;
    delete task.thumbPath;
    delete task.thumbName;
    delete task.thumbUrl;
    delete task.mediaDurationSec;
  }
  // Reprogramar limpia los disparos previos
  task.firedKeys = [];
  return task;
}

// Espera a que se lea la conexión de TikTok (define borrador / posteo directo y el consentimiento)
async function waitTiktokView() {
  if (tiktokComposer.visible && tiktokComposer.viewReady) {
    try { await tiktokComposer.viewReady; } catch (_) { /* se informa en el bloque */ }
  }
}

function urlPathname(u) {
  try { return new URL(String(u)).pathname; } catch (_) { return String(u || ''); }
}

// Valida lo que las redes rechazarían. Devuelve { msg, focus } o null.
function validateForm(task) {
  if (task.type !== 'content' || task.publishMode !== 'auto') return null;
  const plats = task.platforms || [];

  if (!plats.length) {
    return { msg: 'Elegí al menos una plataforma para publicar automáticamente (o elegí «Recordarme y lo subo yo»).', focus: 'input[name="plat"]' };
  }

  // Archivo o URL pública
  const file = task.mediaPath || '';
  const url = task.mediaUrl || '';
  const hasMedia = !!(file || url);
  const fileIsVideo = !!file && VIDEO_EXT.test(file);
  const urlIsImage = !file && !!url && IMAGE_EXT.test(urlPathname(url));

  if (plats.includes('Instagram') && !hasMedia) {
    return { msg: 'Instagram: elegí una imagen o un video (Instagram no permite publicaciones de solo texto).', focus: '#btnPickMedia' };
  }
  for (const p of ['YouTube', 'TikTok']) {
    if (!plats.includes(p)) continue;
    if (!file) {
      return { msg: `${p}: elegí el video desde tu PC con «Elegir archivo» (${p} necesita un archivo de video; no sirve una URL).`, focus: '#btnPickMedia' };
    }
    const accepted = p === 'TikTok' ? TIKTOK_VIDEO_EXT : YOUTUBE_VIDEO_EXT;
    if (!accepted.test(file)) {
      return {
        msg: fileIsVideo
          ? `${p}: ese formato de video no se puede subir. Exportalo como MP4 o MOV.`
          : `${p} solo acepta videos: elegí un archivo MP4 o MOV.`,
        focus: '#btnPickMedia',
      };
    }
  }
  const ctype = String(task.contentType || '').toLowerCase();
  if (/reel|short/.test(ctype) && (!hasMedia || (file && !fileIsVideo) || urlIsImage)) {
    const what = /short/.test(ctype) ? 'Un Short' : 'Un Reel';
    return { msg: `${what} necesita un video: elegí un archivo MP4 o MOV (o cambiá el formato de contenido).`, focus: '#btnPickMedia' };
  }
  // Facebook no publica historias sin archivo (meta.js las rechaza)
  if (plats.includes('Facebook') && !hasMedia && /historia/.test(ctype)) {
    return { msg: 'Facebook: una historia necesita una foto o un video. Elegí un archivo o cambiá el formato de contenido.', focus: '#btnPickMedia' };
  }
  // Publicaciones de solo texto (Threads / Facebook): sin archivo hace falta el epígrafe
  if (!hasMedia && !task.caption) {
    if (plats.includes('Threads')) {
      return { msg: 'Threads: sin imagen ni video, la publicación necesita un texto. Escribí el epígrafe.', focus: '#fCaption' };
    }
    if (plats.includes('Facebook') && !task.link) {
      return { msg: 'Facebook: sin imagen ni video, escribí el texto en el epígrafe (o poné un link).', focus: '#fCaption' };
    }
  }

  if (plats.includes('YouTube')) {
    const yt = youtubeCheck();
    if (yt.titleError) return { msg: 'YouTube: ' + yt.titleError, focus: '#fYtTitle' };
    if (yt.descError) return { msg: 'YouTube: ' + yt.descError, focus: '#fYtDescription' };
  }

  if (plats.includes('TikTok')) {
    const view = tiktokComposer.view;
    const t = task.tiktok || {};
    if (view && view.directPost) {
      if (!t.privacyLevel) {
        return {
          msg: 'TikTok: elegí quién puede ver el video' +
            (tiktokComposer.loaded ? '.' : ' (si no aparecen las opciones, revisá la conexión de TikTok).'),
          focus: '#ttPrivacy',
        };
      }
      if ($('#ttDisclose').checked && !t.brandOrganic && !t.brandedContent) {
        return { msg: 'TikTok: activaste «Divulgar contenido comercial»; elegí «Tu marca» y/o «Contenido de marca».', focus: '#ttBrandOrganic' };
      }
      if (t.brandedContent && t.privacyLevel === 'SELF_ONLY') {
        return { msg: 'TikTok: la visibilidad del contenido de marca no puede ser privada.', focus: '#ttPrivacy' };
      }
    }
  }
  return null;
}

async function checkForm(task) {
  const needsTiktok = task.type === 'content' && task.publishMode === 'auto' &&
    (task.platforms || []).includes('TikTok');
  if (needsTiktok && tiktokComposer.viewReady) {
    try { await tiktokComposer.viewReady; } catch (_) { /* se informa en el bloque */ }
  }
  const err = validateForm(task);
  if (err) {
    showFormError(err);
    return false;
  }
  hideFormError();
  return true;
}

function showFormError(err) {
  const box = $('#formError');
  box.textContent = '⚠️ ' + err.msg;
  box.hidden = false;
  const target = err.focus ? $(err.focus) : null;
  if (target && !target.closest('[hidden]')) {
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => target.focus(), 250);
  } else {
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function hideFormError() {
  const box = $('#formError');
  box.hidden = true;
  box.textContent = '';
}

async function saveForm() {
  await waitTiktokView();
  const task = readForm();
  if (!task.title) { $('#fTitle').focus(); $('#fTitle').style.outline = '2px solid #E84A6F'; return; }
  $('#fTitle').style.outline = '';
  if (!(await checkForm(task))) return;

  await window.api.saveTask(task);

  // Guardar como plantilla
  if ($('#fSaveTemplate').checked) {
    const tpl = {
      id: uid(),
      title: task.title,
      importance: task.importance,
      notes: task.notes,
      type: task.type,
      platforms: task.platforms || [],
      contentType: task.contentType || '',
      durationMin: Math.round((new Date(task.end) - new Date(task.start)) / 60000),
    };
    await window.api.saveTemplate(tpl);
  }

  // Recordatorio Trascendental para historia con link
  if (task.type === 'content' && $('#fStoryLink').checked) {
    const delay = parseInt($('#fStoryDelay').value, 10) || 0;
    const storyStart = new Date(new Date(task.start).getTime() + delay * 60000);
    const story = {
      id: uid(),
      title: 'Subir HISTORIA con link — ' + task.title,
      importance: 'TRASCENDENTAL',
      start: storyStart.toISOString(),
      end: new Date(storyStart.getTime() + 15 * 60000).toISOString(),
      notes: 'Recordatorio para subir una historia con link desde tu cuenta.\nRelacionado a: ' + task.title,
      type: 'content',
      platforms: task.platforms || [],
      contentType: 'Historia',
      recurrence: null,
      status: 'pending',
      firedKeys: [],
      doneOccurrences: [],
      linkedFrom: task.id,
    };
    await window.api.saveTask(story);
  }

  closeForm();
  await load();
}

async function deleteTask() {
  if (!editing) return;
  await window.api.deleteTask(editing.id);
  closeForm();
  await load();
}

async function markDone() {
  if (!editing) return;
  const task = editingBase();
  if (task.recurrence && task.recurrence.freq && task.recurrence.freq !== 'none') {
    task.doneOccurrences = [...(task.doneOccurrences || [])];
    const key = editingOccKey || Recurrence.dayKey(new Date(task.start));
    if (!task.doneOccurrences.includes(key)) task.doneOccurrences.push(key);
  } else {
    task.status = task.status === 'done' ? 'pending' : 'done';
  }
  await window.api.saveTask(task);
  closeForm();
  await load();
}

function reschedule() {
  // Quita el "hecha" de esta ocurrencia y deja editar la fecha para reprogramar
  if (!editing) return;
  const base = editingBase();
  if (base.recurrence && base.recurrence.freq && base.recurrence.freq !== 'none') {
    const key = editingOccKey;
    editingOverrides.doneOccurrences = (base.doneOccurrences || []).filter((k) => k !== key);
  } else {
    editingOverrides.status = 'pending';
  }
  $('#fDate').focus();
  $('#fDate').style.outline = '2px solid #4c8bf5';
  setTimeout(() => ($('#fDate').style.outline = ''), 1500);
}

// --------------------------------------------------------------------------
// Plantillas ("Repetir tarea")
// --------------------------------------------------------------------------
function refreshTemplatesSelect() {
  const sel = $('#fTemplate');
  sel.innerHTML = '<option value="">— Tarea nueva —</option>';
  state.templates.forEach((t) => {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.title + ' (' + (IMPORTANCE[t.importance]?.label || '') + ')';
    sel.appendChild(o);
  });
}

function applyTemplate(id) {
  const tpl = state.templates.find((t) => t.id === id);
  if (!tpl) return;
  $('#fTitle').value = tpl.title;
  setRadio('imp', tpl.importance);
  $('#fNotes').value = tpl.notes || '';
  setRadio('ftype', tpl.type || 'task');
  $$('input[name="plat"]').forEach((c) => { c.checked = (tpl.platforms || []).includes(c.value); });
  if (tpl.contentType) $('#fContentType').value = tpl.contentType;
  // ajustar hora fin según duración guardada
  if (tpl.durationMin) {
    const startDate = combine($('#fDate').value, $('#fStart').value || '09:00');
    $('#fEnd').value = toTimeInput(new Date(startDate.getTime() + tpl.durationMin * 60000));
  }
  syncContentBlock();
  syncAutoFields();
}

async function deleteTemplate() {
  const id = $('#fTemplate').value;
  if (!id) return;
  await window.api.deleteTemplate(id);
  state = await window.api.getData();
  refreshTemplatesSelect();
}

// --------------------------------------------------------------------------
// Listas laterales (pendientes / realizadas)
// --------------------------------------------------------------------------
function renderLists() {
  const pend = $('#listPendientes');
  const done = $('#listRealizadas');
  pend.innerHTML = '';
  done.innerHTML = '';

  const now = new Date();
  const horizonStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const horizonEnd = new Date(horizonStart.getTime() + 30 * 86400000);

  const pendItems = [];
  const doneItems = [];

  for (const task of state.tasks) {
    const instances = Recurrence.expandTask(task, horizonStart, horizonEnd);
    for (const inst of instances) {
      const item = { task, inst };
      if (inst.done) doneItems.push(item);
      else pendItems.push(item);
    }
  }
  pendItems.sort((a, b) => a.inst.start - b.inst.start);
  doneItems.sort((a, b) => b.inst.start - a.inst.start);

  if (!pendItems.length) pend.innerHTML = '<div class="empty-hint">No hay tareas pendientes en los próximos 30 días.</div>';
  if (!doneItems.length) done.innerHTML = '<div class="empty-hint">Todavía no marcaste tareas como hechas.</div>';

  pendItems.forEach(({ task, inst }) => pend.appendChild(taskCard(task, inst, false)));
  doneItems.slice(0, 60).forEach(({ task, inst }) => done.appendChild(taskCard(task, inst, true)));
}

function taskCard(task, inst, isDone) {
  const conf = IMPORTANCE[task.importance] || IMPORTANCE.PRESCINDIBLE;
  const card = document.createElement('div');
  card.className = 'task-card' + (isDone ? ' done' : '');
  card.style.borderLeftColor = conf.color;

  const when = inst.start.toLocaleString('es-AR', {
    weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });

  const tags = [`<span class="tc-tag">${conf.label}</span>`];
  if (task.type === 'content') {
    const plats = (task.platforms || []).join(', ');
    tags.push(`<span class="tc-tag">📲 ${escapeHtml(task.contentType || '')}</span>`);
    if (plats) tags.push(`<span class="tc-tag">${escapeHtml(plats)}</span>`);
    if (task.publishMode === 'auto') tags.push('<span class="tc-tag">🤖 Auto</span>');
  }
  if (task.recurrence && task.recurrence.freq) tags.push('<span class="tc-tag">🔁</span>');

  card.innerHTML = `
    <div class="tc-title">${escapeHtml(task.title)}</div>
    <div class="tc-meta"><span>${when}</span></div>
    <div class="tc-meta">${tags.join('')}</div>`;
  const chips = publishChips(task, inst.occKey);
  if (chips.length) card.appendChild(buildPublishChips(chips));
  card.onclick = () => openForm({ task, occKey: inst.occKey });
  return card;
}

// --------------------------------------------------------------------------
// Estado de publicación por red (por ocurrencia)
// --------------------------------------------------------------------------
// hh:mm si es hoy; dd/mm hh:mm si es otro día
function shortTime(value) {
  const d = toDate(value);
  if (!d) return '';
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return Recurrence.dayKey(d) === Recurrence.dayKey(new Date()) ? hm : formatDayTime(d);
}

function occEntry(map, occKey) {
  const e = map && typeof map === 'object' ? map[occKey] : null;
  return e && typeof e === 'object' ? e : null;
}

// Chips { cls, text, title, url?, conn? } para cada red elegida en la tarea
function publishChips(task, occKey) {
  if (!task || task.type !== 'content' || !occKey) return [];
  const plats = Array.isArray(task.platforms) ? task.platforms : [];
  const published = occEntry(task.publishState, occKey) || {};
  const retry = occEntry(task.retryState, occKey);
  const errors = occEntry(task.publishErrors, occKey) || {};
  // Ocurrencia ya marcada como hecha: el planificador no la publica, así que no se muestra "pendiente"
  const occDone = Recurrence.isOccurrenceDone(task, occKey);
  const chips = [];
  plats.forEach((p) => {
    const ok = published[p] && typeof published[p] === 'object' ? published[p] : null;
    const err = errors[p] && typeof errors[p] === 'object' ? errors[p] : null;
    const errText = err && err.error ? String(err.error) : '';
    const errTitle = errText + (errText && err && toDate(err.at) ? '\n(' + formatDateTime(err.at) + ')' : '');
    // Los errores suelen venir como "Red: motivo": en el chip no se repite el nombre de la red
    const errShort = errText.replace(new RegExp('^\\s*' + String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*', 'i'), '');
    if (ok) {
      const url = ok.url && /^https:\/\//i.test(String(ok.url)) ? String(ok.url) : null;
      chips.push({
        cls: ok.draft ? 'warn' : 'ok',
        text: '✅ ' + p + (ok.draft ? ' (borrador) 📥' : ''),
        title: (ok.draft ? 'Enviado a borradores' : 'Publicado') + (toDate(ok.at) ? ' el ' + formatDateTime(ok.at) : '') + (url ? ' — tocá para abrir' : ''),
        url,
      });
    } else if (retry && retry.nextAt && Array.isArray(retry.platforms) && retry.platforms.includes(p)) {
      chips.push({
        cls: 'pending',
        text: `🔁 ${p} reintenta ${shortTime(retry.nextAt)}`,
        title: errText ? 'Último error: ' + errTitle : 'Se vuelve a intentar automáticamente',
      });
    } else if (err && err.ambiguous) {
      chips.push({ cls: 'warn', text: `⚠️ ${p}: revisar (no confirmado)`, title: errTitle || 'La red no confirmó la publicación: revisala antes de volver a intentar.' });
    } else if (err && err.needsReconnect) {
      chips.push({ cls: 'err', text: `🔄 ${p}: reconectar`, title: (errTitle ? errTitle + '\n' : '') + 'Tocá para abrir ⚙ Conexiones.', conn: PLATFORM_CONN_KEY[p] || true });
    } else if (err) {
      chips.push({ cls: 'err', text: `❌ ${p}: ${errShort || errText || 'no se pudo publicar'}`, title: errTitle || 'No se pudo publicar' });
    } else if (task.publishMode === 'auto' && !occDone) {
      chips.push({ cls: 'pending', text: '⏳ ' + p, title: 'Pendiente de publicar' });
    }
  });
  return chips;
}

function buildPublishChips(chips) {
  const row = elt('div', 'pub-chips');
  chips.forEach((c) => {
    const clickable = !!(c.url || c.conn);
    const chip = elt(clickable ? 'button' : 'span', 'pub-chip ' + c.cls, c.text);
    if (c.title) chip.title = c.title;
    if (clickable) {
      chip.type = 'button';
      chip.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation(); // no abrir la tarea al tocar el chip
        if (c.url) openLink(c.url); // openLink normaliza youtu.be y threads.net
        else openConnections(typeof c.conn === 'string' ? c.conn : undefined);
      };
    }
    row.appendChild(chip);
  });
  return row;
}

// Chips dentro del formulario: ocurrencia en edición (o la del inicio de la tarea)
function renderFormPublishStatus() {
  const field = $('#pubStatusField');
  const box = $('#pubStatus');
  if (!field || !box) return;
  box.innerHTML = '';
  const task = editingBase();
  let occKey = null;
  if (task) {
    const recurring = task.recurrence && task.recurrence.freq && task.recurrence.freq !== 'none';
    const start = toDate(task.start);
    // Sin repetición hay una sola ocurrencia: la del inicio guardado (por si se reprogramó)
    occKey = (recurring && editingOccKey) || (start ? Recurrence.dayKey(start) : editingOccKey);
  }
  const chips = task ? publishChips(task, occKey) : [];
  field.hidden = !chips.length;
  if (chips.length) box.appendChild(buildPublishChips(chips));
}

// --------------------------------------------------------------------------
// Utilidades fecha / forms
// --------------------------------------------------------------------------
function pad(n) { return String(n).padStart(2, '0'); }
function toDateInput(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function toTimeInput(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function combine(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}
function combineSafe(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const d = combine(dateStr, timeStr);
  return isNaN(d.getTime()) ? null : d;
}
function occKeyToDate(occKey, task) {
  const [y, m, d] = occKey.split('-').map(Number);
  const base = new Date(task.start);
  return new Date(y, m - 1, d, base.getHours(), base.getMinutes(), 0, 0);
}
function setRadio(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}
function getRadio(name) {
  const el = document.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : '';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toDate(value) {
  if (value == null || value === '') return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}
// dd/mm/aaaa
function formatDate(value) {
  const d = toDate(value);
  return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : '—';
}
// dd/mm hh:mm
function formatDayTime(value) {
  const d = toDate(value);
  return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '—';
}
// dd/mm/aaaa hh:mm
function formatDateTime(value) {
  const d = toDate(value);
  return d ? `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '—';
}
function formatDuration(sec) {
  const s = Math.round(Number(sec) || 0);
  const m = Math.floor(s / 60);
  return m ? `${m} min ${pad(s % 60)} s` : `${s} s`;
}
function errMsg(e) {
  return (e && e.message) ? e.message : String(e || 'Error desconocido');
}
function elt(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function selectedPlatforms() {
  return $$('input[name="plat"]:checked').map((c) => c.value);
}

// Cierra un modal solo si el clic empezó y terminó en el fondo
// (evita cerrarlo al seleccionar texto y soltar el mouse afuera)
function closeOnBackdrop(sel, onClose) {
  const back = $(sel);
  let downOnBackdrop = false;
  back.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === back; });
  back.addEventListener('click', (e) => {
    if (e.target === back && downOnBackdrop) onClose();
    downOnBackdrop = false;
  });
}

function syncContentBlock() {
  $('#contentBlock').hidden = getRadio('ftype') !== 'content';
}
function syncStoryLink() {
  $('#storyLinkWrap').hidden = !$('#fStoryLink').checked;
}
function syncAutoFields() {
  const isContent = getRadio('ftype') === 'content';
  const auto = isContent && getRadio('pubmode') === 'auto';
  $('#autoFields').hidden = !auto;
  const plats = selectedPlatforms();
  // "Publicar ahora" publica en el momento cualquier tarea de contenido con al menos una red
  // elegida (no hace falta el modo automático ni haber guardado la tarea antes).
  $('#btnPublishNow').hidden = !(isContent && plats.length);
  $('#ytFields').hidden = !(auto && plats.includes('YouTube'));

  const ttVisible = auto && plats.includes('TikTok');
  $('#ttFields').hidden = !ttVisible;
  const wasVisible = tiktokComposer.visible;
  tiktokComposer.visible = ttVisible;
  if (ttVisible && !wasVisible) loadTiktokComposer();
  syncTiktokPreview();

  syncYtBlock();
  syncCaptionCounter();
  syncMediaWarnings();
}

function syncWeekDays() {
  $('#weekDaysBlock').hidden = $('#fRecur').value !== 'weekly';
}

function applyWeekdaysOnly() {
  // Días hábiles = Lunes(1) a Viernes(5)
  const habiles = [1, 2, 3, 4, 5];
  $$('input[name="wday"]').forEach((c) => {
    c.checked = habiles.includes(parseInt(c.value, 10));
  });
}

function renderMediaName() {
  const label = $('#mediaFileName');
  const clearBtn = $('#btnClearMedia');
  if (selectedMedia && selectedMedia.name) {
    label.textContent = selectedMedia.name;
    label.classList.add('has-file');
    clearBtn.hidden = false;
  } else {
    label.textContent = 'Ningún archivo';
    label.classList.remove('has-file');
    clearBtn.hidden = true;
  }
}

async function pickMedia() {
  const res = await window.api.pickMedia();
  if (!res) return;
  if (res.error) { alert('No se pudo cargar el archivo: ' + res.error); return; }
  selectedMedia = { path: res.path, name: res.name };
  $('#fMediaUrl').value = ''; // el archivo tiene prioridad sobre la URL
  renderMediaName();
  probeMediaDuration();
  syncTiktokPreview();
}

function clearMedia() {
  selectedMedia = null;
  $('#fMediaUrl').value = ''; // no dejar la URL pública del archivo anterior
  renderMediaName();
  probeMediaDuration();
  syncTiktokPreview();
}

function renderThumbName() {
  const label = $('#thumbFileName');
  const clearBtn = $('#btnClearThumb');
  if (selectedThumb && selectedThumb.name) {
    label.textContent = selectedThumb.name;
    label.classList.add('has-file');
    clearBtn.hidden = false;
  } else {
    label.textContent = 'Ninguna';
    label.classList.remove('has-file');
    clearBtn.hidden = true;
  }
}

async function pickThumb() {
  const res = await window.api.pickMedia();
  if (!res) return;
  if (res.error) { alert('No se pudo cargar la miniatura: ' + res.error); return; }
  selectedThumb = { path: res.path, name: res.name };
  renderThumbName();
}

function clearThumb() {
  selectedThumb = null;
  renderThumbName();
}

// Lee la duración del video elegido (solo para avisos; si falla, no pasa nada)
function fileUrl(p) {
  const slashed = String(p).replace(/\\/g, '/');
  // Ruta de red (\\servidor\carpeta\video.mp4) → file://servidor/carpeta/video.mp4
  const unc = /^\/\/[^/]/.test(slashed);
  const norm = slashed.replace(/^\/+/, '');
  const parts = norm.split('/').map((seg, i) => (i === 0 && !unc && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)));
  return (unc ? 'file://' : 'file:///') + parts.join('/');
}

function probeMediaDuration() {
  mediaDurationSec = null;
  const p = selectedMedia && selectedMedia.path;
  if (!p || !/\.(mp4|mov|m4v|webm)$/i.test(p)) { syncMediaWarnings(); return; }
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  const release = () => { video.removeAttribute('src'); video.load(); };
  video.onloadedmetadata = () => {
    if (selectedMedia && selectedMedia.path === p && Number.isFinite(video.duration)) {
      mediaDurationSec = video.duration;
      syncMediaWarnings();
    }
    release();
  };
  video.onerror = () => { /* formato no legible por Chromium: sin aviso */ };
  video.src = fileUrl(p);
  syncMediaWarnings();
}

// Vista previa del video en el bloque de TikTok (también mide la duración)
function syncTiktokPreview() {
  const wrap = $('#ttPreviewWrap');
  const video = $('#ttPreview');
  if (!wrap || !video) return;
  const p = (selectedMedia && selectedMedia.path) || '';
  if ($('#ttFields').hidden || !TIKTOK_VIDEO_EXT.test(p)) {
    releaseTiktokPreview();
    return;
  }
  wrap.hidden = false;
  if (video.dataset.path !== p) {
    video.dataset.path = p;
    video.src = fileUrl(p);
  }
}

function releaseTiktokPreview() {
  const wrap = $('#ttPreviewWrap');
  const video = $('#ttPreview');
  if (!wrap || !video) return;
  wrap.hidden = true;
  if (video.dataset.path) {
    delete video.dataset.path;
    try { video.pause(); } catch (_) { /* nada */ }
    video.removeAttribute('src');
    video.load(); // suelta el archivo
  }
}

function onTtPreviewMetadata() {
  const video = $('#ttPreview');
  const p = video.dataset.path;
  if (!p || !selectedMedia || selectedMedia.path !== p) return;
  if (Number.isFinite(video.duration) && video.duration > 0) {
    mediaDurationSec = video.duration;
    syncMediaWarnings();
  }
}

function syncMediaWarnings() {
  const box = $('#mediaWarn');
  if (!box) return;
  const warns = [];
  const p = (selectedMedia && selectedMedia.path) || '';
  const plats = selectedPlatforms();
  const isImage = /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(p);

  if (/\.webm$/i.test(p) && plats.some((x) => ['Instagram', 'Facebook', 'Threads'].includes(x))) {
    warns.push('Los videos .webm no se pueden subir a Instagram, Facebook ni Threads: convertilo a MP4.');
  }
  if (isImage && plats.includes('YouTube')) warns.push('YouTube solo acepta videos.');
  if (isImage && plats.includes('TikTok')) warns.push('TikTok: desde esta app solo se pueden enviar videos.');

  if (mediaDurationSec != null) {
    const info = tiktokComposer.info;
    const maxTt = info && Number(info.maxVideoPostDurationSec);
    if (plats.includes('TikTok') && maxTt && mediaDurationSec > maxTt) {
      warns.push(`TikTok: el video dura ${formatDuration(mediaDurationSec)} y tu cuenta permite hasta ${formatDuration(maxTt)}.`);
    }
    const cover = parseFloat($('#ttCoverSec').value);
    if (plats.includes('TikTok') && Number.isFinite(cover) && cover > mediaDurationSec) {
      warns.push('TikTok: el segundo de portada es mayor que la duración del video.');
    }
    if (plats.includes('YouTube') && /short/i.test($('#fContentType').value) && mediaDurationSec > 180) {
      warns.push(`YouTube: los Shorts pueden durar hasta 3 minutos y este video dura ${formatDuration(mediaDurationSec)}.`);
    }
  }

  box.hidden = !warns.length;
  box.textContent = warns.map((w) => '⚠️ ' + w).join('\n');
}

function syncCaptionCounter() {
  const box = $('#captionCount');
  if (!box) return;
  const len = $('#fCaption').value.trim().length; // UTF-16, como cuentan TikTok e Instagram
  const plats = selectedPlatforms();
  const over = CAPTION_LIMITS.filter(([p, max]) => plats.includes(p) && len > max);
  let txt = len ? `${len} caracteres` : '';
  if (over.length) {
    txt += ' — ⚠️ supera el límite de ' + over.map(([p, max]) => `${p} (${max})`).join(', ');
  }
  box.textContent = txt;
  box.classList.toggle('over', over.length > 0);
}

// --------------------------------------------------------------------------
// Bloque YouTube del formulario
// --------------------------------------------------------------------------
function youtubeCheck() {
  const ytTitle = $('#fYtTitle').value.trim();
  const title = ytTitle || $('#fTitle').value.trim();
  const ytDesc = $('#fYtDescription').value.trim();
  const caption = $('#fCaption').value.trim();
  // Igual que youtube.js: descripción → epígrafe (nunca las notas internas); #Shorts solo si no está ya
  let desc = ytDesc || caption;
  const descSource = ytDesc ? '' : (caption ? 'epígrafe' : '');
  if ($('#fYtShorts').checked && !/(^|\s)#shorts\b/i.test(desc)) {
    const base = desc.replace(/\s+$/, '');
    desc = base ? base + YT_SHORTS_SUFFIX : '#Shorts';
  }

  const titleLen = Array.from(title).length;
  const descBytes = new TextEncoder().encode(desc).length;
  let titleError = null;
  let descError = null;
  if (!title) titleError = 'poné un título para el video.';
  else if (/[<>]/.test(title)) titleError = 'el título no puede tener los signos < ni >.';
  else if (titleLen > YT_TITLE_MAX) titleError = `el título tiene ${titleLen} caracteres y el máximo es ${YT_TITLE_MAX}.`;
  if (/[<>]/.test(desc)) descError = 'la descripción no puede tener los signos < ni >.';
  else if (descBytes > YT_DESC_MAX_BYTES) descError = `la descripción ocupa ${descBytes} bytes y el máximo es ${YT_DESC_MAX_BYTES} (los acentos y emojis ocupan más de 1).`;

  return { titleLen, titleFromTask: !ytTitle, descBytes, descSource, titleError, descError };
}

function auditWarning() {
  return statusOf('youtube').warnings.find((w) => /auditor/i.test(w)) || null;
}

function syncYtBlock() {
  if ($('#ytFields').hidden) return;
  const yt = youtubeCheck();

  const tc = $('#ytTitleCount');
  tc.textContent = `${yt.titleLen}/${YT_TITLE_MAX}` + (yt.titleFromTask && yt.titleLen ? ' · nombre de la tarea' : '');
  tc.classList.toggle('over', yt.titleLen > YT_TITLE_MAX);
  $('#ytTitleError').hidden = !yt.titleError;
  $('#ytTitleError').textContent = yt.titleError ? '⚠️ YouTube: ' + yt.titleError : '';

  const dc = $('#ytDescCount');
  dc.textContent = `${yt.descBytes}/${YT_DESC_MAX_BYTES}` + (yt.descSource && yt.descBytes ? ' · ' + yt.descSource : '');
  dc.classList.toggle('over', yt.descBytes > YT_DESC_MAX_BYTES);
  $('#ytDescError').hidden = !yt.descError;
  $('#ytDescError').textContent = yt.descError ? '⚠️ YouTube: ' + yt.descError : '';

  // Qué visibilidad va a tener (política de YouTube: mostrarla antes de subir)
  const privacy = $('#fYtPrivacy').value || 'public';
  const when = combineSafe($('#fDate').value, $('#fStart').value || '09:00');
  const plan = youtubePlanText(privacy, when) + '.';
  const lines = [];
  if (when && when.getTime() > Date.now()) {
    // El planificador publica a la hora de la tarea; «Publicar ahora» sube en el momento
    lines.push('Automático: el ' + formatDayTime(when) + ' se publica en YouTube como ' + ytPrivacyLabel(privacy) +
      ($('#fRecur').value !== 'none' ? ' (y en cada repetición)' : '') + '.');
    if (editing) lines.push('Con «Publicar ahora»: ' + plan);
  } else {
    lines.push(plan);
  }
  const others = otherNetworksText(selectedPlatforms());
  if (others) lines.push(others);
  $('#ytVisibility').textContent = lines.join('\n');

  const warns = [];
  const aw = auditWarning();
  if (aw) warns.push(aw);
  if (apiStatus && apiStatus.youtube) {
    const s = statusOf('youtube');
    if (s.needsReconnect || s.revoked) warns.push('YouTube pide volver a conectar la cuenta (⚙ Conexiones → YouTube → Conectar).');
    // Sin revisar todavía (recién abierta la app): no se afirma que esté desconectado
    else if (!s.connected && s.checkedAt) warns.push('YouTube todavía no está conectado (⚙ Conexiones).');
  }
  const box = $('#ytAuditWarn');
  box.hidden = !warns.length;
  box.textContent = warns.map((w) => '⚠️ ' + w).join('\n');
}

// --------------------------------------------------------------------------
// Bloque TikTok del formulario (pautas de contenido de TikTok)
// --------------------------------------------------------------------------
function tiktokPrivacyLabel(value) {
  return TIKTOK_PRIVACY_LABELS[value] || value || '—';
}

function resetTiktokControls(saved) {
  const s = saved || {};
  const sel = $('#ttPrivacy');
  sel.innerHTML = '';
  sel.appendChild(new Option('— Elegí quién puede verlo —', ''));
  // Hasta que TikTok responda, se conserva la opción guardada
  if (s.privacyLevel) sel.appendChild(new Option(tiktokPrivacyLabel(s.privacyLevel), s.privacyLevel));
  sel.value = s.privacyLevel || '';

  [['#ttAllowComment', 'allowComment'], ['#ttAllowDuet', 'allowDuet'], ['#ttAllowStitch', 'allowStitch']].forEach(([id, key]) => {
    const c = $(id);
    c.disabled = false;
    c.checked = !!s[key];
  });
  $('#ttInteractionNote').hidden = true;
  $('#ttDisclose').checked = !!(s.brandOrganic || s.brandedContent);
  $('#ttBrandOrganic').checked = !!s.brandOrganic;
  $('#ttBrandedContent').checked = !!s.brandedContent;
  $('#ttCoverSec').value = Number.isFinite(s.coverTimestampMs) ? String(s.coverTimestampMs / 1000) : '';
  $('#ttCreator').hidden = true;
  $('#ttAvatar').removeAttribute('src');
  $('#ttNickname').textContent = '';
  $('#ttDirect').hidden = true;
  $('#ttDraftNote').hidden = true;
  setTtMessage(null);
  tiktokComposer.info = null;
  tiktokComposer.loaded = false;
  syncTiktokDisclosure();
}

function readTiktokForm() {
  const disclose = $('#ttDisclose').checked;
  const sec = parseFloat($('#ttCoverSec').value);
  return {
    privacyLevel: $('#ttPrivacy').value || '',
    allowComment: !$('#ttAllowComment').disabled && $('#ttAllowComment').checked,
    allowDuet: !$('#ttAllowDuet').disabled && $('#ttAllowDuet').checked,
    allowStitch: !$('#ttAllowStitch').disabled && $('#ttAllowStitch').checked,
    brandOrganic: disclose && $('#ttBrandOrganic').checked,
    brandedContent: disclose && $('#ttBrandedContent').checked,
    coverTimestampMs: Number.isFinite(sec) && sec >= 0 ? Math.round(sec * 1000) : null,
    consent: tiktokConsent(),
  };
}

// Consentimiento solo si se publica automático en TikTok y se vio lo que corresponde:
// modo bandeja (borradores), o los controles de posteo directo con la privacidad elegida
function tiktokConsent() {
  if (getRadio('ftype') !== 'content' || getRadio('pubmode') !== 'auto') return false;
  if (!selectedPlatforms().includes('TikTok')) return false;
  const view = tiktokComposer.view;
  if (!view) return false;
  if (!view.directPost) return true;
  return !$('#ttDirect').hidden && !!$('#ttPrivacy').value;
}

// Mensaje del bloque de TikTok con acciones opcionales ('retry' | 'conn')
function setTtMessage(kind, text, actions = []) {
  const box = $('#ttMessage');
  box.innerHTML = '';
  if (!kind) { box.className = 'conn-result'; return; }
  box.className = 'conn-result ' + kind;
  box.appendChild(elt('span', null, text));
  if (actions.length) {
    const row = elt('div', 'inline-actions');
    if (actions.includes('retry')) {
      const b = elt('button', 'btn-small', '↻ Reintentar');
      b.type = 'button';
      b.onclick = () => loadTiktokComposer();
      row.appendChild(b);
    }
    if (actions.includes('conn')) {
      const b = elt('button', 'btn-small', '⚙ Abrir conexiones');
      b.type = 'button';
      b.onclick = () => openConnections('tiktok');
      row.appendChild(b);
    }
    box.appendChild(row);
  }
}

function loadTiktokComposer() {
  const reqId = ++tiktokComposer.reqId;
  tiktokComposer.loaded = false;
  tiktokComposer.info = null;
  $('#ttDraftNote').hidden = true;
  $('#ttDirect').hidden = true;
  $('#ttCreator').hidden = true;
  setTtMessage('info', 'Consultando tu cuenta de TikTok…');

  const viewReady = (async () => {
    try {
      return await window.api.getConnection('tiktok');
    } catch (e) {
      return { __error: errMsg(e) };
    }
  })();
  tiktokComposer.viewReady = viewReady;

  viewReady.then(async (view) => {
    if (reqId !== tiktokComposer.reqId) return;
    if (!view || view.__error) {
      tiktokComposer.view = null;
      setTtMessage('err', '❌ No se pudo leer la conexión de TikTok' + (view && view.__error ? ': ' + view.__error : '.'), ['retry']);
      return;
    }
    tiktokComposer.view = view;

    // Sin auditoría: va a borradores y no se muestran los controles de posteo directo
    if (!view.directPost) {
      $('#ttDraftNote').hidden = false;
      if (view.needsReconnect) setTtMessage('warn', 'TikTok pide volver a conectar la cuenta.', ['conn']);
      else if (!view.connected) setTtMessage('warn', 'TikTok todavía no está conectado.', ['conn']);
      else setTtMessage(null);
      return;
    }

    $('#ttDirect').hidden = false;
    if (view.needsReconnect || !view.connected) {
      setTtMessage('err', view.needsReconnect
        ? 'TikTok pide volver a conectar la cuenta antes de publicar.'
        : 'TikTok no está conectado: conectalo para elegir la visibilidad.', ['conn', 'retry']);
      syncTiktokDisclosure();
      return;
    }

    let res;
    try {
      res = await window.api.tiktokCreatorInfo();
    } catch (e) {
      res = { ok: false, error: errMsg(e) };
    }
    if (reqId !== tiktokComposer.reqId) return;
    if (!res || !res.ok || !res.info) {
      setTtMessage('err', '❌ ' + ((res && res.error) || 'No se pudo consultar tu cuenta de TikTok.'), ['retry']);
      syncTiktokDisclosure();
      return;
    }
    setTtMessage(null);
    applyCreatorInfo(res.info);
  });
}

function applyCreatorInfo(info) {
  tiktokComposer.info = info;
  tiktokComposer.loaded = true;

  // Cabecera: avatar + apodo
  const img = $('#ttAvatar');
  if (info.avatarUrl && /^https:\/\//i.test(info.avatarUrl)) {
    img.src = info.avatarUrl;
    img.hidden = false;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
  }
  const nick = info.nickname || info.username || 'tu cuenta';
  $('#ttNickname').textContent = nick + (info.username && info.username !== nick ? ' (@' + String(info.username).replace(/^@/, '') + ')' : '');
  $('#ttCreator').hidden = false;

  // Privacidad: solo las opciones que da TikTok, sin valor por defecto
  const options = Array.isArray(info.privacyLevelOptions) ? info.privacyLevelOptions : [];
  const sel = $('#ttPrivacy');
  const current = sel.value;
  sel.innerHTML = '';
  sel.appendChild(new Option('— Elegí quién puede verlo —', ''));
  options.forEach((opt) => sel.appendChild(new Option(tiktokPrivacyLabel(opt), opt)));
  sel.value = options.includes(current) ? current : '';

  // Interacciones deshabilitadas por la cuenta
  const off = [];
  [['#ttAllowComment', 'commentDisabled', 'comentarios'], ['#ttAllowDuet', 'duetDisabled', 'Dúo'], ['#ttAllowStitch', 'stitchDisabled', 'Stitch']].forEach(([id, flag, name]) => {
    const c = $(id);
    c.disabled = !!info[flag];
    if (info[flag]) {
      c.checked = false;
      off.push(name);
    }
  });
  const note = $('#ttInteractionNote');
  note.hidden = !off.length;
  note.textContent = off.length ? 'Desactivado en la configuración de tu cuenta de TikTok: ' + off.join(', ') + '.' : '';

  syncTiktokDisclosure();
  syncMediaWarnings();
}

function syncTiktokDisclosure() {
  const on = $('#ttDisclose').checked;
  $('#ttDiscloseOptions').hidden = !on;
  const organic = on && $('#ttBrandOrganic').checked;
  const branded = on && $('#ttBrandedContent').checked;

  // El contenido de marca no puede ser "Solo yo"
  const sel = $('#ttPrivacy');
  const selfOpt = Array.from(sel.options).find((o) => o.value === 'SELF_ONLY');
  if (selfOpt) {
    selfOpt.disabled = branded;
    selfOpt.textContent = tiktokPrivacyLabel('SELF_ONLY') + (branded ? ' (no disponible para contenido de marca)' : '');
    if (branded && sel.value === 'SELF_ONLY') sel.value = '';
  }
  $('#ttPrivacyHint').hidden = !branded;

  let label = '';
  if (branded) label = 'Tu video se va a etiquetar como «Colaboración pagada».';
  else if (organic) label = 'Tu video se va a etiquetar como «Contenido promocional».';
  $('#ttDiscloseLabel').textContent = label;
  $('#ttDiscloseLabel').hidden = !label;
  $('#ttDiscloseError').hidden = !(on && !organic && !branded);

  // Declaración de consentimiento
  const decl = $('#ttDeclaration');
  decl.innerHTML = '';
  decl.appendChild(document.createTextNode('Al publicar, aceptás la '));
  decl.appendChild(linkTo(TIKTOK_MUSIC_URL, 'Declaración de confirmación de uso de música de TikTok'));
  if (branded) {
    decl.appendChild(document.createTextNode(' y la '));
    decl.appendChild(linkTo(TIKTOK_BC_URL, 'Política de contenido de marca'));
  }
  decl.appendChild(document.createTextNode('.'));
}

function linkTo(url, text) {
  const a = elt('a', null, text);
  a.href = '#';
  a.dataset.open = url;
  return a;
}

// --------------------------------------------------------------------------
// Publicar ahora (manual)
// --------------------------------------------------------------------------
function ytPrivacyLabel(privacy) {
  return YT_PRIVACY_LABELS[privacy] || YT_PRIVACY_LABELS.public;
}

// Qué hace YouTube al publicar ahora (igual que youtube.js: Público con fecha futura → Privado + publicación programada)
function youtubePlanText(privacy, start) {
  const p = YT_PRIVACY_LABELS[privacy] ? privacy : 'public';
  const when = toDate(start);
  if (p === 'public' && when && when.getTime() > Date.now() + YT_SCHEDULE_MIN_AHEAD_MS) {
    return 'YouTube: se sube ahora como Privado y se publica solo el ' + formatDayTime(when);
  }
  return 'YouTube: se publica ahora como ' + ytPrivacyLabel(p);
}

// 'Facebook, Instagram y TikTok se publican en el momento.' (solo las redes elegidas)
function otherNetworksText(plats) {
  const others = ['Facebook', 'Instagram', 'Threads', 'TikTok'].filter((p) => (plats || []).includes(p));
  if (!others.length) return '';
  const last = others[others.length - 1];
  const list = others.length === 1 ? last : others.slice(0, -1).join(', ') + (/^i/i.test(last) ? ' e ' : ' y ') + last;
  return list + (others.length === 1 ? ' se publica' : ' se publican') + ' en el momento.';
}

function publishConfirmText(task) {
  const plats = task.platforms || [];
  const lines = ['¿Publicar ahora en ' + plats.join(', ') + '?', ''];
  if (plats.includes('YouTube')) {
    lines.push(youtubePlanText(task.ytPrivacy, task.start) + '.');
    const aw = auditWarning();
    if (aw) lines.push('⚠️ ' + aw);
  }
  const others = otherNetworksText(plats);
  if (others) lines.push(others);
  if (plats.includes('TikTok')) {
    const v = tiktokComposer.view;
    if (v && v.directPost) {
      lines.push('', 'TikTok: quién puede verlo → ' + tiktokPrivacyLabel(task.tiktok && task.tiktok.privacyLevel) + '.');
    } else {
      lines.push('', 'TikTok: se envía como borrador a tu bandeja.');
    }
  }
  return lines.join('\n');
}

async function publishNow() {
  // Se puede publicar en el momento incluso una tarea nueva sin guardar:
  // readForm() le crea un id propio y más abajo se guarda antes de publicar.
  if ($('#modal').hidden) return;
  await waitTiktokView();
  const task = readForm();
  if (!task.title) { $('#fTitle').focus(); return; }
  if (!(task.platforms || []).length) {
    showFormError({ msg: 'Elegí al menos una plataforma para publicar.' });
    return;
  }
  if (!(await checkForm(task))) return;
  if (!confirm(publishConfirmText(task))) return;

  const btn = $('#btnPublishNow');
  btn.disabled = true;
  btn.textContent = 'Publicando…';
  let results;
  try {
    await window.api.saveTask(task);
    results = await window.api.publishNow(task);
  } catch (e) {
    results = [{ error: errMsg(e) }];
  } finally {
    btn.disabled = false;
    btn.textContent = '📤 Publicar ahora';
  }
  if (!Array.isArray(results)) results = [{ error: 'La app no devolvió resultados.' }];
  const hasErrors = results.some((r) => r && r.error);
  if (!hasErrors) closeForm();
  showPublishResults(results);
  await load();
}

function showPublishResults(results) {
  const list = $('#resultList');
  list.innerHTML = '';
  let needConn = false;

  if (!results.length) {
    list.appendChild(elt('div', 'result-row warn', 'No había plataformas para publicar.'));
  }

  results.forEach((raw) => {
    const r = raw || {};
    let icon = '✅';
    let cls = 'ok';
    let text = 'Publicado.';
    if (r.skipped) {
      icon = '⏭️'; cls = 'skip'; text = 'Ya estaba publicado: no se volvió a subir.';
    } else if (r.error) {
      // ambiguous: la red no confirmó y puede que se haya publicado (no se reintenta solo)
      icon = r.ambiguous ? '⚠️' : (r.transient ? '⏳' : '❌');
      cls = r.ambiguous ? 'warn' : 'err';
      text = r.error;
      if (r.transient && !r.ambiguous) text += '\nEs un problema temporal: se puede reintentar más tarde.';
      if (r.needsReconnect) {
        needConn = true;
        text += '\nHay que volver a conectar la cuenta en ⚙ Conexiones.';
      }
    } else if (r.draft) {
      icon = '📥'; cls = 'warn'; text = 'Enviado a borradores: terminá de publicarlo desde la app.';
    }

    const row = elt('div', 'result-row ' + cls);
    const head = elt('div', 'result-head');
    head.appendChild(elt('span', 'result-icon', icon));
    head.appendChild(elt('strong', null, r.platform || 'Publicación'));
    row.appendChild(head);
    row.appendChild(elt('div', 'result-text', text));
    (Array.isArray(r.warnings) ? r.warnings : []).forEach((w) => row.appendChild(elt('div', 'result-warn', '⚠️ ' + w)));
    if (r.url && /^https:\/\//i.test(r.url)) {
      const a = linkTo(r.url, 'Ver publicación');
      a.className = 'result-link';
      row.appendChild(a);
    }
    list.appendChild(row);
  });

  const failed = results.filter((r) => r && r.error).length;
  $('#resultTitle').textContent = failed ? 'Hubo problemas al publicar' : 'Publicación terminada';
  $('#resultOpenConn').hidden = !needConn;
  $('#resultModal').hidden = false;
}

function closeResults() {
  $('#resultModal').hidden = true;
}

// --------------------------------------------------------------------------
// Enlaces externos y portapapeles
// --------------------------------------------------------------------------
async function copyText(text, btn) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch (_e) { ok = false; }
    ta.remove();
  }
  if (btn) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = ok ? '✓ Copiado' : 'No se pudo copiar';
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1600);
  }
  return ok;
}

// Las redes a veces devuelven dominios cortos o viejos (youtu.be, threads.net) que el
// proceso principal no abre: se pasan al dominio canónico, con la misma ruta
function normalizeExternalUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'https:') return String(raw);
    const host = u.hostname.toLowerCase();
    if (host === 'youtu.be') {
      const id = u.pathname.replace(/^\/+/, '').split('/')[0];
      return id ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(id) : String(raw);
    }
    const canonical = {
      'youtube.com': 'www.youtube.com', 'm.youtube.com': 'www.youtube.com',
      'threads.net': 'www.threads.com', 'www.threads.net': 'www.threads.com', 'threads.com': 'www.threads.com',
      'instagram.com': 'www.instagram.com', 'facebook.com': 'www.facebook.com',
      'm.facebook.com': 'www.facebook.com', 'web.facebook.com': 'www.facebook.com', 'tiktok.com': 'www.tiktok.com',
    };
    if (!canonical[host]) return String(raw);
    u.hostname = canonical[host];
    return u.toString();
  } catch (_) {
    return String(raw);
  }
}

async function openLink(rawUrl) {
  if (!rawUrl) return;
  const url = normalizeExternalUrl(rawUrl);
  let opened = false;
  try {
    opened = await window.api.openExternal(url);
  } catch (_) {
    opened = false;
  }
  if (!opened) {
    const copied = await copyText(url);
    alert('No se pudo abrir el enlace en el navegador.' + (copied ? '\nLo copié al portapapeles:\n' : '\n') + url);
  }
}

function onLinkClick(e) {
  const a = e.target.closest('[data-open], [data-link]');
  if (!a) return;
  e.preventDefault();
  const url = a.dataset.open || appInfo[a.dataset.link];
  openLink(url);
}

async function loadAppInfo() {
  try {
    const info = await window.api.getAppInfo();
    if (info) appInfo = { ...APP_INFO_FALLBACK, ...info };
  } catch (_) { /* se usan los valores de respaldo */ }
  renderUris();
  $('#appVersion').textContent = appInfo.version ? 'v' + appInfo.version : '';
}

// --------------------------------------------------------------------------
// Estado de las APIs
// --------------------------------------------------------------------------
function emptyStatus() {
  return { ok: false, connected: false, account: null, expiresAt: null, needsReconnect: false, revoked: false, warnings: [], error: null, checkedAt: null };
}

// Estado más reciente de una plataforma (el global o el que vino con la VIEW)
function statusOf(key) {
  const a = apiStatus && apiStatus[key];
  const v = connViews[key] && connViews[key].status;
  let s = a || v || null;
  if (a && v && (Number(v.checkedAt) || 0) > (Number(a.checkedAt) || 0)) s = v;
  s = s || {};
  return { ...emptyStatus(), ...s, warnings: Array.isArray(s.warnings) ? s.warnings : [] };
}

// ¿La VIEW dice que está conectada? (null = todavía no se leyó)
function viewConnected(key) {
  const v = connViews[key];
  if (!v || typeof v !== 'object') return null;
  return key === 'hosting' ? !!v.configured : !!v.connected;
}

// Nombre de la cuenta según la VIEW (para mostrar mientras se verifica)
function viewAccount(key) {
  const v = connViews[key] || {};
  const at = (n) => (n ? '@' + String(n).replace(/^@/, '') : '');
  switch (key) {
    case 'facebook': return v.pageName || v.pageId || '';
    case 'instagram': return at(v.igUsername) || v.igUserId || '';
    case 'threads': return at(v.username) || v.userId || '';
    case 'youtube': return v.channel || '';
    case 'tiktok': return v.displayName || '';
    case 'hosting': return v.cloudName || '';
    default: return '';
  }
}

// Conectada según lo guardado, pero todavía sin verificar (arranque o nunca revisada)
function isVerifying(s, key) {
  if (s.connected || s.needsReconnect || s.revoked) return false;
  if (connViews[key] && connViews[key].needsReconnect) return false; // lo guardado ya pide reconectar
  const unchecked = !(apiStatus && apiStatus.checkedAt) || !s.checkedAt;
  return unchecked && viewConnected(key) === true;
}

function badgeFor(s, key) {
  if (s.revoked) return { cls: 'err', text: '⛔ Acceso revocado' };
  if (s.needsReconnect) return { cls: 'err', text: '🔄 Reconectar' };
  if (!s.connected) {
    if (isVerifying(s, key)) return { cls: 'pending', text: '⏳ Verificando…' };
    if (key === 'hosting') return { cls: s.error ? 'err' : 'off', text: '❌ Sin configurar' };
    return { cls: s.error ? 'err' : 'off', text: '❌ Desconectado' };
  }
  if (!s.ok || s.error) return { cls: 'err', text: '❌ Error' };
  if (s.warnings.length) return { cls: 'warn', text: '⚠️ Atención' };
  return { cls: 'ok', text: '✅ Conectado' };
}

function applyStatus(all) {
  if (!all || typeof all !== 'object') return;
  apiStatus = all;
  renderStatusGrid();
  renderConnBadges();
  if (!$('#modal').hidden) syncYtBlock();
  // Con la ventana de conexiones abierta, las VIEW (ej. needsReconnect) cambian junto con el estado
  if (!$('#connModal').hidden) refreshViewsQuietly();
}

// Vuelve a leer las VIEW sin pisar lo que el usuario está escribiendo en los campos
let viewsRefreshing = null;
let viewsRefreshAgain = false;
function refreshViewsQuietly() {
  // Si llega otro cambio mientras se leen, se vuelve a leer una vez al terminar
  if (viewsRefreshing) { viewsRefreshAgain = true; return viewsRefreshing; }
  viewsRefreshAgain = false;
  viewsRefreshing = Promise.all(CONN_PLATFORMS.map(async (p) => {
    try {
      const view = await window.api.getConnection(p.key);
      if (!view || typeof view !== 'object') return;
      connViews[p.key] = view;
      const sec = connSection(p.key);
      if (sec) {
        sec.querySelectorAll('input[type="password"][data-has]').forEach((inp) => {
          inp.placeholder = view[inp.dataset.has] ? '•••••• guardado' : '';
        });
      }
      renderConnInfo(p.key);
    } catch (_) { /* se mantiene la vista anterior */ }
  })).then(() => {
    renderUris();
    renderStatusGrid();
    renderConnBadges();
  }).finally(() => {
    viewsRefreshing = null;
    if (viewsRefreshAgain && !$('#connModal').hidden) refreshViewsQuietly();
  });
  return viewsRefreshing;
}

async function loadStatus() {
  try {
    applyStatus(await window.api.getStatus());
  } catch (_) { /* el proceso principal todavía no tiene estado */ }
}

async function refreshStatusNow() {
  const btn = $('#btnRefreshStatus');
  btn.disabled = true;
  btn.textContent = '🔄 Verificando…';
  try {
    applyStatus(await window.api.refreshStatus());
  } catch (e) {
    alert('No se pudo verificar el estado: ' + errMsg(e));
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 Verificar ahora';
  }
}

function renderStatusGrid() {
  const grid = $('#statusGrid');
  grid.innerHTML = '';
  CONN_PLATFORMS.forEach((p) => {
    const s = statusOf(p.key);
    const b = badgeFor(s, p.key);
    const card = elt('div', 'status-card ' + b.cls);
    card.tabIndex = 0;
    card.title = 'Ver la configuración de ' + p.label;

    const head = elt('div', 'status-card-head');
    head.appendChild(elt('span', 'status-name', p.icon + ' ' + p.label));
    head.appendChild(elt('span', 'badge ' + b.cls, b.text));
    card.appendChild(head);

    const account = s.account || (b.cls === 'pending'
      ? (viewAccount(p.key) || 'Verificando la conexión…')
      : (s.connected ? (p.key === 'hosting' ? 'Configurado' : 'Conectado') : (p.key === 'hosting' ? 'Sin configurar' : 'Sin cuenta conectada')));
    card.appendChild(elt('div', 'status-account', account));
    if (p.key !== 'hosting' && s.connected && !s.needsReconnect && !s.revoked) {
      card.appendChild(elt('div', 'status-exp', s.expiresAt ? 'Vence: ' + formatDate(s.expiresAt) : 'No vence'));
    }
    if (s.warnings.length) {
      const ul = elt('ul', 'status-warnings');
      s.warnings.forEach((w) => ul.appendChild(elt('li', null, w)));
      card.appendChild(ul);
    }
    if (s.error) card.appendChild(elt('div', 'status-error', s.error));

    card.onclick = () => openConnSection(p.key);
    card.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openConnSection(p.key); }
    };
    grid.appendChild(card);
  });

  const when = apiStatus && apiStatus.checkedAt;
  $('#statusCheckedAt').textContent = when ? 'Última verificación: ' + formatDateTime(when) : 'Todavía no se verificó';

  const rec = apiStatus && apiStatus.recovery;
  const notice = $('#recoveryNotice');
  notice.hidden = !rec;
  notice.textContent = rec
    ? '⚠️ Se recuperaron tus credenciales desde una copia de respaldo' + (toDate(rec.at) ? ' (' + formatDateTime(rec.at) + ')' : '') + '. Revisá que cada conexión siga funcionando.'
    : '';
}

// Badges de cada sección y aviso en el botón de la barra lateral
function renderConnBadges() {
  let errs = 0;
  let warns = 0;
  CONN_PLATFORMS.forEach((p) => {
    const s = statusOf(p.key);
    const b = badgeFor(s, p.key);
    const badge = $(`.conn-details[data-platform="${p.key}"] [data-role="badge"]`);
    if (badge) {
      badge.className = 'badge ' + b.cls;
      badge.textContent = b.text;
    }
    if (s.revoked || s.needsReconnect || (s.connected && (!s.ok || s.error))) errs++;
    else if (p.key !== 'hosting' && s.connected && s.warnings.length) warns++;
  });
  const dot = $('#connAlertDot');
  dot.hidden = !(errs || warns);
  dot.className = 'conn-dot ' + (errs ? 'err' : 'warn');
  dot.textContent = errs ? String(errs) : '!';
  dot.title = errs
    ? errs + (errs === 1 ? ' conexión necesita atención' : ' conexiones necesitan atención')
    : 'Hay avisos en las conexiones';
}

// --------------------------------------------------------------------------
// Conexiones (configuración por red)
// --------------------------------------------------------------------------
function connSection(key) {
  return $(`.conn-details[data-platform="${key}"]`);
}

function platformLabel(key) {
  const p = CONN_PLATFORMS.find((x) => x.key === key);
  return p ? p.label : key;
}

async function openConnections(focusKey) {
  const modal = $('#connModal');
  const wasOpen = !modal.hidden;
  modal.hidden = false;
  if (!wasOpen) {
    CONN_PLATFORMS.forEach((p) => setConnResult(p.key, null));
    renderStatusGrid();
    renderConnBadges();
    await Promise.all([
      loadAppInfo(),
      loadStatus(),
      ...CONN_PLATFORMS.map((p) => loadConnection(p.key)),
    ]);
  } else {
    loadStatus();
  }
  if (typeof focusKey === 'string') openConnSection(focusKey);
}

function closeConnections() {
  $('#connModal').hidden = true;
  // No dejar tokens pegados ni claves escritas en pantalla
  $$('#connModal [data-role="pasteInput"]').forEach((ta) => { ta.value = ''; });
  $$('#connModal input[type="password"]').forEach((inp) => { inp.value = ''; });
  // Si el formulario sigue abierto, refrescar lo que depende de las conexiones
  if (!$('#modal').hidden) {
    if (tiktokComposer.visible) loadTiktokComposer();
    syncYtBlock();
  }
}

function openConnSection(key) {
  const sec = connSection(key);
  if (!sec) return;
  sec.open = true;
  sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function loadConnection(key) {
  try {
    const view = await window.api.getConnection(key);
    fillConnSection(key, view);
  } catch (e) {
    setConnResult(key, 'err', '❌ No se pudo leer la configuración: ' + errMsg(e));
  }
}

function fillConnSection(key, view) {
  if (!view || typeof view !== 'object') return;
  connViews[key] = view;
  const sec = connSection(key);
  if (!sec) return;
  sec.querySelectorAll('[data-field]').forEach((input) => {
    const f = input.dataset.field;
    if (input.type === 'checkbox') {
      input.checked = !!view[f];
    } else if (input.type === 'password') {
      // Las claves nunca vuelven al renderer: solo sabemos si hay una guardada
      input.value = '';
      input.placeholder = view[input.dataset.has] ? '•••••• guardado' : '';
    } else if (f === 'redirectUri') {
      const v = view.redirectUri || '';
      input.value = v && v !== appInfo.redirectUri ? v : '';
      input.placeholder = appInfo.redirectUri;
    } else {
      input.value = view[f] == null ? '' : String(view[f]);
    }
  });
  renderConnInfo(key);
  renderUris();
  renderStatusGrid();
  renderConnBadges();
}

function renderConnInfo(key) {
  const sec = connSection(key);
  const box = sec && sec.querySelector('[data-role="info"]');
  if (!box) return;
  const v = connViews[key] || {};
  const at = (name) => (name ? '@' + String(name).replace(/^@/, '') : '');
  const exp = (ms) => (ms ? 'vence el ' + formatDate(ms) : 'no vence');
  let txt = '';
  switch (key) {
    case 'facebook': {
      const types = { PAGE: 'de Página', USER: 'de Usuario', SYSTEM_USER: 'de Usuario del sistema' };
      txt = v.connected
        ? `Página conectada: ${v.pageName || v.pageId || '—'}` + (v.tokenType ? ` · Token ${types[v.tokenType] || v.tokenType}` : '') + ` · ${exp(v.expiresAt)}`
        : 'Todavía no conectaste tu Página.';
      break;
    }
    case 'instagram':
      txt = v.connected ? `Cuenta conectada: ${at(v.igUsername) || v.igUserId || '—'} · ${exp(v.expiresAt)}` : 'Todavía no conectaste Instagram.';
      break;
    case 'threads':
      txt = v.connected ? `Perfil conectado: ${at(v.username) || v.userId || '—'} · ${exp(v.expiresAt)}` : 'Todavía no conectaste Threads.';
      break;
    case 'youtube':
      if (v.needsReconnect) txt = '⚠️ Google revocó o venció el acceso: tocá Conectar de nuevo.';
      else txt = v.connected ? `Canal conectado: ${v.channel || '—'}` : 'Todavía no conectaste YouTube.';
      break;
    case 'tiktok':
      if (v.needsReconnect) txt = '⚠️ TikTok pide volver a conectar la cuenta: tocá Conectar.';
      else if (v.connected) {
        txt = `Cuenta conectada: ${v.displayName || '—'}` +
          (v.refreshExpiresAt ? ` · reconectar antes del ${formatDate(v.refreshExpiresAt)}` : '') +
          (v.directPost ? ' · posteo directo' : ' · envía a borradores');
      } else txt = 'Todavía no conectaste TikTok.';
      break;
    case 'hosting':
      txt = v.configured ? `Configurado: ${v.cloudName || '—'} · preset ${v.uploadPreset || '—'}` : 'Sin configurar.';
      break;
    default:
      txt = '';
  }
  box.textContent = txt;
}

function uriFor(kind) {
  switch (kind) {
    case 'facebook': return appInfo.facebookRedirectUri;
    case 'instagram': return (connViews.instagram && connViews.instagram.redirectUri) || appInfo.redirectUri;
    case 'threads': return (connViews.threads && connViews.threads.redirectUri) || appInfo.redirectUri;
    case 'tiktok': return appInfo.tiktokRedirectUri;
    default: return '';
  }
}

function renderUris() {
  $$('[data-uri]').forEach((code) => { code.textContent = uriFor(code.dataset.uri); });
  $$('.conn-details input[data-field="redirectUri"]').forEach((inp) => { inp.placeholder = appInfo.redirectUri; });
}

function setConnResult(key, kind, text) {
  const sec = connSection(key);
  const box = sec && sec.querySelector('[data-role="result"]');
  if (!box) return;
  box.className = 'conn-result' + (kind ? ' ' + kind : '');
  box.textContent = kind ? text : '';
}

function setSectionBusy(sec, busy) {
  sec.classList.toggle('busy', busy);
  sec.querySelectorAll('button[data-action]').forEach((b) => { b.disabled = busy; });
}

function readConnSection(key) {
  const sec = connSection(key);
  const data = {};
  sec.querySelectorAll('[data-field]').forEach((input) => {
    const f = input.dataset.field;
    if (input.type === 'checkbox') data[f] = input.checked;
    else if (input.type === 'number') {
      const raw = input.value.trim();
      // Texto no numérico: el navegador devuelve '' pero marca badInput
      if (input.validity && input.validity.badInput) data[f] = NaN;
      else data[f] = raw === '' ? '' : Number(raw);
    } else data[f] = input.value.trim();
  });
  return data;
}

// Vacío = conservar lo guardado (contrato). Pero si el usuario borra un valor que
// estaba guardado, se manda el valor por defecto para poder volver atrás.
function applyClearedDefaults(key, data) {
  const view = connViews[key] || {};
  if (key === 'hosting') {
    ['maxVideoMB', 'maxImageMB'].forEach((f) => {
      if (data[f] === '' && Number(view[f]) > 0) data[f] = 0; // 0 = límite del plan gratis
    });
  }
  if (data.redirectUri === '' && view.redirectUri && appInfo.redirectUri && view.redirectUri !== appInfo.redirectUri) {
    data.redirectUri = appInfo.redirectUri;
  }
  return data;
}

function validateConnData(key, data) {
  if (key === 'hosting') {
    for (const f of ['maxVideoMB', 'maxImageMB']) {
      if (data[f] !== '' && !(Number.isFinite(data[f]) && data[f] > 0)) {
        return 'Los tamaños máximos tienen que ser números mayores a 0 (o dejalos vacíos).';
      }
    }
  }
  if (data.redirectUri && !/^https:\/\/[^\s]+$/i.test(data.redirectUri)) {
    return 'El URI de redireccionamiento tiene que empezar con https://';
  }
  return null;
}

async function saveConnSection(key) {
  const data = readConnSection(key);
  const bad = validateConnData(key, data);
  if (bad) throw new Error(bad);
  applyClearedDefaults(key, data);
  const view = await window.api.saveConnection(key, data);
  fillConnSection(key, view);
  return view;
}

function handleConnResponse(key, res) {
  if (!res || typeof res !== 'object') throw new Error('La app no devolvió respuesta.');
  if (res.view) fillConnSection(key, res.view);
  if (res.ok) {
    const lines = ['✅ Conectado' + (res.account ? ': ' + res.account : '.')];
    if (res.expiresAt) lines.push('Vence: ' + formatDate(res.expiresAt));
    else if (res.expiresAt === null) lines.push('No vence.');
    const warnings = Array.isArray(res.warnings) ? res.warnings : [];
    warnings.forEach((w) => lines.push('⚠️ ' + w));
    setConnResult(key, warnings.length ? 'warn' : 'ok', lines.join('\n'));
  } else {
    setConnResult(key, 'err', '❌ ' + (res.error || 'No se pudo conectar.'));
  }
  if (!res.view) loadConnection(key);
  loadStatus();
}

async function onConnAction(key, action) {
  const sec = connSection(key);
  if (!sec || sec.classList.contains('busy')) return;
  const label = platformLabel(key);

  if (action === 'disconnect') {
    const ok = confirm(`¿Desconectar ${label}?\n\nSe borran los tokens de acceso. Los datos de la app (identificador y clave) quedan guardados.`);
    if (!ok) return;
  }

  setSectionBusy(sec, true);
  try {
    if (action === 'save') {
      await saveConnSection(key);
      setConnResult(key, 'ok', '✅ Guardado.');
      loadStatus();
    } else if (action === 'connect') {
      await saveConnSection(key);
      const browser = key === 'youtube' || key === 'tiktok';
      setConnResult(key, 'info', browser
        ? 'Se abrió tu navegador para autorizar… Cuando termines, volvé a esta ventana.'
        : 'Se abrió una ventana para autorizar… Iniciá sesión y aceptá los permisos.');
      handleConnResponse(key, await window.api.connect(key));
    } else if (action === 'disconnect') {
      const view = await window.api.disconnect(key);
      fillConnSection(key, view);
      setConnResult(key, 'ok', `Se desconectó ${label}. Los datos de la app quedaron guardados.`);
      loadStatus();
    } else if (action === 'paste') {
      const ta = sec.querySelector('[data-role="pasteInput"]');
      const token = ta.value.trim();
      ta.value = ''; // el token no queda en pantalla
      if (!token) {
        setConnResult(key, 'err', 'Pegá el token en el cuadro de texto.');
        return;
      }
      setConnResult(key, 'info', 'Verificando el token…');
      handleConnResponse(key, await window.api.pasteToken(key, token));
    }
  } catch (e) {
    setConnResult(key, 'err', '❌ ' + errMsg(e));
  } finally {
    setSectionBusy(sec, false);
  }
}

function onConnModalClick(e) {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) {
    e.preventDefault();
    copyText(uriFor(copyBtn.dataset.copy), copyBtn);
    return;
  }
  const actBtn = e.target.closest('button[data-action]');
  if (actBtn) {
    const sec = actBtn.closest('.conn-details');
    if (sec) onConnAction(sec.dataset.platform, actBtn.dataset.action);
  }
}

// --------------------------------------------------------------------------
// Eventos UI
// --------------------------------------------------------------------------
function wire() {
  $('#btnNew').onclick = () => openForm({ date: new Date() });
  $('#modalClose').onclick = closeForm;
  closeOnBackdrop('#modal', closeForm);
  $('#btnSave').onclick = saveForm;
  $('#btnDelete').onclick = deleteTask;
  $('#btnDone').onclick = markDone;
  $('#btnReschedule').onclick = reschedule;
  $('#btnDeleteTemplate').onclick = deleteTemplate;
  $('#btnPublishNow').onclick = publishNow;
  $('#btnPickMedia').onclick = pickMedia;
  $('#btnClearMedia').onclick = clearMedia;
  $('#btnPickThumb').onclick = pickThumb;
  $('#btnClearThumb').onclick = clearThumb;
  $('#fRecur').onchange = () => { syncWeekDays(); syncYtBlock(); };
  $('#fWeekdaysOnly').onchange = (e) => { if (e.target.checked) applyWeekdaysOnly(); };
  $('#fTemplate').onchange = (e) => { if (e.target.value) applyTemplate(e.target.value); };
  $$('input[name="ftype"]').forEach((r) => (r.onchange = () => { syncContentBlock(); syncAutoFields(); }));
  $$('input[name="pubmode"]').forEach((r) => (r.onchange = syncAutoFields));
  $$('input[name="plat"]').forEach((c) => (c.onchange = syncAutoFields));
  $('#fStoryLink').onchange = syncStoryLink;
  $('#fContentType').addEventListener('change', syncMediaWarnings);

  // YouTube: contadores y visibilidad en vivo
  ['#fYtTitle', '#fYtDescription', '#fTitle', '#fCaption', '#fDate', '#fStart'].forEach((sel) => {
    $(sel).addEventListener('input', syncYtBlock);
  });
  $('#fYtPrivacy').onchange = syncYtBlock;
  $('#fYtShorts').onchange = syncYtBlock;
  $('#fCaption').addEventListener('input', syncCaptionCounter);

  // TikTok
  $('#ttDisclose').onchange = syncTiktokDisclosure;
  $('#ttBrandOrganic').onchange = syncTiktokDisclosure;
  $('#ttBrandedContent').onchange = syncTiktokDisclosure;
  $('#ttCoverSec').addEventListener('input', syncMediaWarnings);
  $('#btnTtReload').onclick = () => loadTiktokComposer();
  $('#ttPreview').addEventListener('loadedmetadata', onTtPreviewMetadata);

  // Conexiones
  $('#btnConnections').onclick = () => openConnections();
  $('#connClose').onclick = closeConnections;
  $('#connDone').onclick = closeConnections;
  closeOnBackdrop('#connModal', closeConnections);
  $('#btnRefreshStatus').onclick = refreshStatusNow;
  $('#connModal').addEventListener('click', onConnModalClick);

  // Publicidad (Meta/Instagram Ads)
  $('#btnAds').onclick = () => openAds();
  // Google Ads
  $('#btnGads').onclick = () => openGads();
  $('#gadsX').onclick = closeGads;
  $('#gadsClose').onclick = closeGads;
  closeOnBackdrop('#gadsModal', closeGads);
  $('#gadsConnectBtn').onclick = connectGads;
  $('#gadsRefreshBtn').onclick = () => renderGadsOverview();
  $('#gadsDisconnectBtn').onclick = disconnectGads;
  $('#gadsCampaigns').addEventListener('click', onGadsCampaignClick);
  // Tablero unificado
  $('#btnDash').onclick = () => openDash();
  $('#dashX').onclick = closeDash;
  $('#dashClose').onclick = closeDash;
  $('#dashRefresh').onclick = () => renderDash();
  closeOnBackdrop('#dashModal', closeDash);
  // Historial / Comparativa
  $('#btnHist').onclick = () => openHist();
  $('#histX').onclick = closeHist;
  $('#histClose').onclick = closeHist;
  closeOnBackdrop('#histModal', closeHist);
  $('#histUpdate').onclick = () => histUpdateNow();
  $('#histRebuild').onclick = () => histRebuildNow();
  $('#histOpenSheet').onclick = () => histOpenSheet();
  $('#histApplyCustom').onclick = () => { histState.from = $('#histFrom').value; histState.to = $('#histTo').value; renderHist(); };
  $('#histPeriods').addEventListener('click', onHistPeriodClick);
  $('#histMetricTabs').addEventListener('click', onHistMetricClick);
  $('#adsClose').onclick = closeAds;
  closeOnBackdrop('#adsModal', closeAds);
  $('#adsListBtn').onclick = () => adsListAccounts();
  $('#adsConnectBtn').onclick = () => adsConnect();
  $('#adsRefreshBtn').onclick = () => renderAdsOverviewForced();
  $('#adsDisconnectBtn').onclick = () => adsDisconnect();
  $('#adsCampaigns').addEventListener('click', onAdsCampaignClick);
  $('#adsConfirmOk').onclick = () => adsConfirmClose(true);
  $('#adsConfirmCancel').onclick = () => adsConfirmClose(false);
  $('#adsConfirmX').onclick = () => adsConfirmClose(false);
  closeOnBackdrop('#adsConfirmModal', () => adsConfirmClose(false));
  $('#adsBoostLoad').onclick = () => loadBoostPosts();
  $('#adsBoostPosts').addEventListener('click', onBoostPostClick);
  $('#adsBoostCreate').onclick = () => createBoostNow();
  $$('#adsPlatformFilter .ads-filter-btn').forEach((b) => {
    b.onclick = () => {
      adsPlatformFilter = b.dataset.plat || 'all';
      $$('#adsPlatformFilter .ads-filter-btn').forEach((x) => x.classList.toggle('active', x === b));
      applyAdsFilter();
    };
  });
  // Selector de cuenta (botones dinámicos → delegación)
  $('#adsAccountFilter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-acc]');
    if (!b) return;
    adsAccountFilter = b.dataset.acc || 'all';
    applyAdsFilter();
  });
  // Renombrar campaña (alias local)
  $('#adsAliasX').onclick = closeAliasEditor;
  $('#adsAliasCancel').onclick = closeAliasEditor;
  $('#adsAliasSave').onclick = () => saveAlias($('#adsAliasInput').value);
  $('#adsAliasClear').onclick = () => saveAlias('');
  closeOnBackdrop('#adsAliasModal', closeAliasEditor);
  $('#adsAliasInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveAlias($('#adsAliasInput').value); } });
  // Objetivos de campaña (metas locales)
  $('#adsObjX').onclick = closeObjEditor;
  $('#adsObjCancel').onclick = closeObjEditor;
  $('#adsObjSave').onclick = () => saveObjectives(false);
  $('#adsObjClear').onclick = () => saveObjectives(true);
  closeOnBackdrop('#adsObjModal', closeObjEditor);
  // Pausas programadas
  $('#adsSchedAddBtn').onclick = openSchedEditor;
  $('#adsSchedX').onclick = closeSchedEditor;
  $('#adsSchedCancel').onclick = closeSchedEditor;
  $('#adsSchedSave').onclick = saveSchedule;
  closeOnBackdrop('#adsSchedModal', closeSchedEditor);
  $('#adsSchedList').addEventListener('click', onAdsSchedListClick);
  $$('input[name="adsSchedType"]').forEach((r) => { r.onchange = updateSchedType; });
  // Informe (demografía + gráficos)
  $('#adsReportBtn').onclick = openReport;
  $('#adsReportX').onclick = closeReport;
  $('#adsReportClose').onclick = closeReport;
  closeOnBackdrop('#adsReportModal', closeReport);
  if (typeof window.api.onOpenAds === 'function') window.api.onOpenAds(() => openAds());
  if (typeof window.api.onAdsChanged === 'function') window.api.onAdsChanged(() => { if (!$('#adsModal').hidden && !$('#adsOverview').hidden) renderAdsOverview(); });

  // Resultado de publicación
  $('#resultClose').onclick = closeResults;
  $('#resultOk').onclick = closeResults;
  closeOnBackdrop('#resultModal', closeResults);
  $('#resultOpenConn').onclick = () => { closeResults(); openConnections(); };

  // Enlaces externos (privacidad, términos, paneles de las redes)
  document.addEventListener('click', onLinkClick);

  // Estado de las APIs desde el proceso principal
  if (typeof window.api.onStatusChanged === 'function') window.api.onStatusChanged((all) => applyStatus(all));
  if (typeof window.api.onOpenConnections === 'function') window.api.onOpenConnections(() => openConnections());

  // Tabs
  $$('.tab').forEach((tab) => {
    tab.onclick = () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.tab;
      $('#listPendientes').hidden = which !== 'pendientes';
      $('#listRealizadas').hidden = which !== 'realizadas';
    };
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#adsAliasModal').hidden) closeAliasEditor();
    else if (!$('#adsObjModal').hidden) closeObjEditor();
    else if (!$('#adsReportModal').hidden) closeReport();
    else if (!$('#adsSchedModal').hidden) closeSchedEditor();
    else if (!$('#adsConfirmModal').hidden) adsConfirmClose(false);
    else if (!$('#resultModal').hidden) closeResults();
    else if (!$('#gadsModal').hidden) closeGads();
    else if (!$('#dashModal').hidden) closeDash();
    else if (!$('#histModal').hidden) closeHist();
    else if (!$('#adsModal').hidden) closeAds();
    else if (!$('#connModal').hidden) closeConnections();
    else if (!$('#modal').hidden) closeForm();
  });
}

// --------------------------------------------------------------------------
// Publicidad (Meta / Instagram Ads) — Fase 1: ver rendimiento
// --------------------------------------------------------------------------
function openAds() {
  $('#adsModal').hidden = false;
  loadAds();
}
function closeAds() {
  $('#adsModal').hidden = true;
}

let adsCampaignsById = {};
let adsCurrency = 'ARS';
let adsConfirmResolver = null;

// Confirmación reutilizable (devuelve Promise<boolean>)
function adsConfirm({ title = 'Confirmar', message = '', okLabel = 'Confirmar', danger = false } = {}) {
  return new Promise((resolve) => {
    adsConfirmResolver = resolve;
    $('#adsConfirmTitle').textContent = title;
    $('#adsConfirmMsg').textContent = message;
    const ok = $('#adsConfirmOk');
    ok.textContent = okLabel;
    ok.classList.toggle('btn-danger', !!danger);
    ok.classList.toggle('btn-primary', !danger);
    $('#adsConfirmModal').hidden = false;
  });
}
function adsConfirmClose(result) {
  $('#adsConfirmModal').hidden = true;
  const r = adsConfirmResolver;
  adsConfirmResolver = null;
  if (r) r(result);
}
function adsShowError(msg) {
  const err = $('#adsError');
  err.textContent = '⚠️ ' + msg;
  err.hidden = false;
}

// ====================== GOOGLE ADS ======================
// Panel propio (stateless: pide los datos en vivo). Reutiliza adsConfirm/adsMoney/adsInt/escapeHtml.
let gadsCampaignsById = {};
const GADS_CUR = 'ARS'; // moneda de la cuenta (la API devuelve costo en micros de esa moneda)

function openGads() { $('#gadsModal').hidden = false; loadGads(); }
function closeGads() { $('#gadsModal').hidden = true; }
function setGadsView(v) {
  $('#gadsLoading').hidden = v !== 'loading';
  $('#gadsSetup').hidden = v !== 'setup';
  $('#gadsOverview').hidden = v !== 'overview';
}
async function loadGads() {
  setGadsView('loading');
  let st;
  try { st = await window.api.gadsStatus(); } catch (_) { st = null; }
  if ($('#gadsModal').hidden) return;
  if (st && st.connected) { await renderGadsOverview(); }
  else { $('#gadsSetupMsg').hidden = true; setGadsView('setup'); }
}
async function connectGads() {
  const btn = $('#gadsConnectBtn'); const msg = $('#gadsSetupMsg');
  msg.hidden = true;
  const customerId = $('#gadsCustomerId').value.trim();
  if (!customerId) { msg.textContent = 'Poné el Customer ID.'; msg.hidden = false; return; }
  btn.disabled = true; btn.textContent = 'Abriendo Google…';
  try {
    const r = await window.api.gadsConnect({ customerId });
    if (r && r.ok) { await loadGads(); }
    else { msg.textContent = (r && r.error) || 'No se pudo conectar.'; msg.hidden = false; }
  } catch (_) { msg.textContent = 'No se pudo conectar.'; msg.hidden = false; }
  finally { btn.disabled = false; btn.textContent = 'Conectar Google Ads'; }
}
async function disconnectGads() {
  const ok = await adsConfirm({ title: 'Desconectar Google Ads', message: '¿Desconectar Google Ads de la app? Podés reconectar cuando quieras.', okLabel: 'Desconectar', danger: true });
  if (!ok) return;
  try { await window.api.gadsDisconnect(); } catch (_) {}
  loadGads();
}
async function renderGadsOverview() {
  setGadsView('loading');
  let ov;
  try { ov = await window.api.gadsOverview(); } catch (_) { ov = null; }
  if ($('#gadsModal').hidden) return;
  if (!ov || !ov.ok) {
    if (ov && ov.connected === false) { setGadsView('setup'); return; }
    setGadsView('overview');
    $('#gadsError').textContent = '⚠️ ' + ((ov && ov.error) || 'No se pudo leer Google Ads.');
    $('#gadsError').hidden = false;
    $('#gadsTotals').innerHTML = ''; $('#gadsCampaigns').innerHTML = '';
    return;
  }
  setGadsView('overview');
  $('#gadsError').hidden = true;
  $('#gadsAccountName').textContent = 'Cuenta ' + (ov.customerId || '');
  const t = ov.totals || {};
  const impr = Number(t.impressions) || 0, clicks = Number(t.clicks) || 0;
  const ctr = impr ? (clicks / impr) * 100 : 0;
  $('#gadsTotals').innerHTML = `<div class="ads-card">
    <div class="ads-card-label">Últimos 30 días</div>
    <div class="ads-card-spend">${adsMoney(t.cost, GADS_CUR)}</div>
    <div class="ads-card-sub">${adsInt(impr)} impres. · ${adsInt(clicks)} clics · CTR ${ctr.toFixed(1)}%</div>
    <div class="ads-card-sub">${adsInt(t.conversions)} conversiones</div>
  </div>`;
  gadsCampaignsById = {};
  for (const c of (ov.campaigns || [])) gadsCampaignsById[c.id] = c;
  const camps = ov.campaigns || [];
  $('#gadsCampaigns').innerHTML = camps.length
    ? camps.map((c) => gadsCampaignRow(c)).join('')
    : '<p class="hint">No hay campañas con datos en los últimos 30 días.</p>';
}
function gadsStatusLabel(s) { const m = { ENABLED: 'Activa', PAUSED: 'Pausada', REMOVED: 'Eliminada' }; return m[s] || s || '—'; }
function gadsCampaignRow(c) {
  const badge = c.running
    ? '<span class="ads-badge on">● Activa</span>'
    : '<span class="ads-badge off">⏸ ' + escapeHtml(gadsStatusLabel(c.status)) + '</span>';
  const btn = c.status === 'ENABLED'
    ? `<button type="button" class="btn-small ads-act" data-gads-action="pause" data-camp-id="${escapeHtml(c.id)}">⏸ Pausar</button>`
    : (c.status === 'PAUSED' ? `<button type="button" class="btn-small ads-act" data-gads-action="activate" data-camp-id="${escapeHtml(c.id)}">▶ Activar</button>` : '');
  const ctr = (Number(c.impressions) ? (c.clicks / c.impressions) * 100 : 0).toFixed(1);
  return `<div class="ads-camp${c.running ? ' on' : ''}">
    <div class="ads-camp-head">
      <span class="ads-camp-name-wrap"><span class="ads-camp-name">${escapeHtml(c.name || '(sin nombre)')}</span></span>
      <span class="ads-camp-right">${badge}${btn}</span>
    </div>
    <div class="ads-camp-metrics">
      <span>30 días: ${adsMoney(c.cost, GADS_CUR)} · ${adsInt(c.impressions)} impres. · ${adsInt(c.clicks)} clics · CTR ${ctr}%</span>
      <span>${adsInt(c.conversions)} conversiones${c.avgCpc ? ' · CPC ' + adsMoney(c.avgCpc, GADS_CUR) : ''}</span>
    </div>
  </div>`;
}
async function onGadsCampaignClick(e) {
  const btn = e.target.closest('[data-gads-action]');
  if (!btn) return;
  const id = btn.dataset.campId;
  const c = gadsCampaignsById[id];
  if (!c) return;
  const toActive = btn.dataset.gadsAction === 'activate';
  const ok = await adsConfirm({
    title: toActive ? 'Activar campaña (Google Ads)' : 'Pausar campaña (Google Ads)',
    message: toActive
      ? `Vas a ACTIVAR «${c.name}» en Google Ads.\n\nVa a empezar a gastar plata real. ¿Confirmás?`
      : `Vas a PAUSAR «${c.name}» en Google Ads.\n\nDeja de mostrarse y de gastar. ¿Confirmás?`,
    okLabel: toActive ? 'Sí, activar' : 'Sí, pausar',
    danger: toActive,
  });
  if (!ok) return;
  btn.disabled = true; btn.textContent = '…';
  try {
    const r = await window.api.gadsSetStatus({ campaignId: id, status: toActive ? 'ENABLED' : 'PAUSED' });
    if (r && r.ok) { await renderGadsOverview(); }
    else {
      $('#gadsError').textContent = '⚠️ ' + ((r && r.error) || 'No se pudo cambiar la campaña.');
      $('#gadsError').hidden = false;
      btn.disabled = false; btn.textContent = toActive ? '▶ Activar' : '⏸ Pausar';
    }
  } catch (_) { btn.disabled = false; btn.textContent = toActive ? '▶ Activar' : '⏸ Pausar'; }
}

// ====================== TABLERO UNIFICADO (Meta + Google Ads + consultas/ventas) ======================
let dashCharts = [];
function destroyDashCharts() { for (const c of dashCharts) { try { c.destroy(); } catch (_) {} } dashCharts = []; }
function openDash() { $('#dashModal').hidden = false; renderDash(); }
function closeDash() { destroyDashCharts(); $('#dashModal').hidden = true; }
async function renderDash() {
  $('#dashContent').hidden = true;
  $('#dashLoading').hidden = false; $('#dashLoading').textContent = 'Cargando datos de los canales…';
  const [meta, google, con] = await Promise.all([
    window.api.adsOverview().catch(() => null),
    window.api.gadsOverview().catch(() => null),
    window.api.adsGetConsultas().catch(() => null),
  ]);
  if ($('#dashModal').hidden) return;
  const cur = 'ARS';
  const m = (meta && meta.connected && meta.last30) ? meta.last30 : null;
  const g = (google && google.ok && google.totals) ? google.totals : null;
  const channels = [
    { name: 'Meta Ads', color: '#4c8bf5', connected: !!m, spend: m ? Number(m.spend) || 0 : 0, impr: m ? Number(m.impressions) || 0 : 0, clicks: m ? Number(m.clicks) || 0 : 0 },
    { name: 'Google Ads', color: '#EA4335', connected: !!g, spend: g ? Number(g.cost) || 0 : 0, impr: g ? Number(g.impressions) || 0 : 0, clicks: g ? Number(g.clicks) || 0 : 0 },
  ];
  for (const ch of channels) ch.ctr = ch.impr ? (ch.clicks / ch.impr) * 100 : 0;
  const totSpend = channels.reduce((s, c) => s + c.spend, 0);
  const totImpr = channels.reduce((s, c) => s + c.impr, 0);
  const totClicks = channels.reduce((s, c) => s + c.clicks, 0);
  const totCtr = totImpr ? (totClicks / totImpr) * 100 : 0;
  const f = (con && con.ok && con.last30) ? con.last30 : null;
  const consultas = f ? Number(f.consultas) || 0 : 0;
  const ventas = f ? Number(f.ventas) || 0 : 0;
  const cvr = f ? (f.cvr != null ? Number(f.cvr) : (consultas ? (ventas / consultas) * 100 : 0)) : 0;

  $('#dashStats').innerHTML = [
    adsStatCard('Gasto total', adsMoney(totSpend, cur)),
    adsStatCard('Impresiones', adsInt(totImpr)),
    adsStatCard('Clics', adsInt(totClicks)),
    adsStatCard('CTR', totCtr.toFixed(1) + '%'),
    adsStatCard('Consultas', f ? adsInt(consultas) : '—'),
    adsStatCard('Ventas', f ? adsInt(ventas) : '—'),
    adsStatCard('CVR', f ? cvr.toFixed(1) + '%' : '—'),
  ].join('');

  $('#dashChannels').innerHTML = channels.map((ch) => `<div class="ads-camp">
    <div class="ads-camp-head">
      <span class="ads-camp-name">${escapeHtml(ch.name)}${ch.connected ? '' : ' <small class="hint">(no conectado)</small>'}</span>
      <span class="ads-camp-right"><strong>${adsMoney(ch.spend, cur)}</strong></span>
    </div>
    <div class="ads-camp-metrics">
      <span>${adsInt(ch.impr)} impres. · ${adsInt(ch.clicks)} clics · CTR ${ch.ctr.toFixed(1)}%</span>
      <span>${totSpend ? (ch.spend / totSpend * 100).toFixed(0) + '% del gasto' : ''}</span>
    </div>
  </div>`).join('');

  const imprPorConsulta = consultas ? Math.round(totImpr / consultas) : 0;
  const costoConsulta = consultas ? totSpend / consultas : 0;
  const costoVenta = ventas ? totSpend / ventas : 0;
  $('#dashFunnel').innerHTML = f ? `<div class="ads-funnel-card">
    <div class="ads-funnel-step"><span class="ads-funnel-k">👁️ Impresiones (Meta + Google)</span><span class="ads-funnel-v">${adsInt(totImpr)}</span></div>
    <div class="ads-funnel-link">${consultas ? '1 consulta cada <strong>' + adsInt(imprPorConsulta) + '</strong> impresiones' : 'sin consultas'}</div>
    <div class="ads-funnel-step"><span class="ads-funnel-k">💬 Consultas</span><span class="ads-funnel-v">${adsInt(consultas)}</span></div>
    <div class="ads-funnel-link">conversión (CVR) <strong>${cvr.toFixed(1)}%</strong></div>
    <div class="ads-funnel-step"><span class="ads-funnel-k">🛒 Ventas</span><span class="ads-funnel-v">${adsInt(ventas)}</span></div>
    <div class="ads-funnel-costs">Costo por consulta: <strong>${consultas ? adsMoney(costoConsulta, cur) : '—'}</strong> · por venta: <strong>${ventas ? adsMoney(costoVenta, cur) : '—'}</strong> <small>(gasto total de ambos canales)</small></div>
  </div>` : '<p class="hint">Abrí el Contador de Consultas en esta PC para ver el embudo con tus consultas y ventas.</p>';

  const notConn = channels.filter((c) => !c.connected).map((c) => c.name);
  $('#dashNote').textContent = (notConn.length ? '⚠️ ' + notConn.join(' y ') + ' no está(n) conectado(s): el total no los incluye. ' : '')
    + 'Las consultas de WhatsApp no se separan por canal: el embudo las toma del total de la cuenta.';

  $('#dashLoading').hidden = true;
  $('#dashContent').hidden = false;
  renderDashCharts(channels);
}
function renderDashCharts(channels) {
  destroyDashCharts();
  if (typeof Chart === 'undefined') return;
  try { Chart.defaults.color = '#9aa3b2'; } catch (_) {}
  const labels = channels.map((c) => c.name);
  const colors = channels.map((c) => c.color);
  dashCharts.push(new Chart($('#dashChartSpend'), { type: 'bar', data: { labels, datasets: [{ data: channels.map((c) => c.spend), backgroundColor: colors, borderRadius: 4 }] }, options: adsChartOpts() }));
  dashCharts.push(new Chart($('#dashChartImpr'), { type: 'bar', data: { labels, datasets: [{ data: channels.map((c) => c.impr), backgroundColor: colors, borderRadius: 4 }] }, options: adsChartOpts() }));
}

// ====================== HISTORIAL / COMPARATIVA ======================
// Lee el historial (hoja de cálculo en userData) y compara período vs período anterior.
// Reutiliza adsStatCard/adsMoney/adsInt/adsChartOpts/adsConfirm/escapeHtml.
let histCharts = [];
function destroyHistCharts() { for (const c of histCharts) { try { c.destroy(); } catch (_) {} } histCharts = []; }
const histState = { period: 'mes', metric: 'gasto', from: '', to: '', data: null };
const HIST_METRIC_NAME = { gasto: 'del gasto', impresiones: 'de impresiones', clics: 'de clics', consultas: 'de consultas' };

function openHist() { $('#histModal').hidden = false; histShowSaveWarning(false); renderHist(); }
function closeHist() { destroyHistCharts(); $('#histModal').hidden = true; }
function histShowSaveWarning(show) {
  const w = $('#histWarn');
  if (show) { w.innerHTML = '⚠️ No se pudo guardar el historial. Si tenés la hoja abierta en Excel, <strong>cerrala</strong> y reintentá.'; w.hidden = false; }
  else { w.hidden = true; }
}

function onHistPeriodClick(e) {
  const b = e.target.closest('.hist-period-btn'); if (!b) return;
  histState.period = b.dataset.period || 'mes';
  $$('#histPeriods .hist-period-btn').forEach((x) => x.classList.toggle('active', x === b));
  const isCustom = histState.period === 'custom';
  $('#histCustom').hidden = !isCustom;
  if (isCustom) {
    if (!$('#histFrom').value || !$('#histTo').value) {
      const t = new Date();
      $('#histFrom').value = toDateInput(new Date(t.getTime() - 29 * 86400000));
      $('#histTo').value = toDateInput(t);
    }
    histState.from = $('#histFrom').value; histState.to = $('#histTo').value;
  }
  renderHist();
}
function onHistMetricClick(e) {
  const b = e.target.closest('.hist-metric-btn'); if (!b) return;
  histState.metric = b.dataset.metric || 'gasto';
  $$('#histMetricTabs .hist-metric-btn').forEach((x) => x.classList.toggle('active', x === b));
  if (histState.data) renderHistChart(histState.data);
}

async function renderHist() {
  $('#histContent').hidden = true;
  $('#histEmpty').hidden = true;
  $('#histLoading').hidden = false;
  destroyHistCharts();
  const payload = { period: histState.period };
  if (histState.period === 'custom') { payload.from = histState.from; payload.to = histState.to; }
  let res;
  try { res = await window.api.histComparison(payload); } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
  if ($('#histModal').hidden) return;
  $('#histLoading').hidden = true;
  if (!res || !res.ok) {
    $('#histEmpty').hidden = false;
    $('#histEmpty').innerHTML = '⚠️ ' + escapeHtml((res && res.error) || 'No se pudo armar la comparativa.');
    return;
  }
  histState.data = res;
  if (!res.coverage || !res.coverage.rows) {
    $('#histEmpty').hidden = false;
    $('#histEmpty').innerHTML = 'Todavía no hay historial guardado. Tocá <strong>⟲ Reconstruir</strong> para traer de Meta y Google los últimos meses, o <strong>🔄 Actualizar</strong> para empezar a registrar desde hoy.';
    return;
  }
  renderHistHeader(res);
  renderHistStats(res);
  renderHistTable(res);
  renderHistChannels(res);
  renderHistNote(res);
  $('#histContent').hidden = false;
  renderHistChart(res);
}

function histFmtDate(ymd) { const p = String(ymd || '').split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : (ymd || ''); }

function renderHistHeader(res) {
  const a = res.windows.actual, b = res.windows.anterior;
  $('#histRangeLine').innerHTML = `<span class="hist-range-badge hist-range-actual">${escapeHtml(res.label)} actual: ${histFmtDate(a.from)} → ${histFmtDate(a.to)} <small>(${a.days} días)</small></span>`
    + `<span class="hist-range-vs">vs</span>`
    + `<span class="hist-range-badge hist-range-prev">anterior: ${histFmtDate(b.from)} → ${histFmtDate(b.to)} <small>(${b.days} días)</small></span>`;
}

function histDeltaChip(d, dir) {
  if (!d || d.pct == null) return '<span class="hist-chip hist-chip-flat" title="sin dato comparable">s/d</span>';
  const arrow = d.pct > 0 ? '▲' : (d.pct < 0 ? '▼' : '=');
  let cls = 'hist-chip-neutral';
  if (d.pct !== 0 && dir !== 'neutral') cls = ((dir === 'down') ? d.pct < 0 : d.pct > 0) ? 'hist-chip-up' : 'hist-chip-down';
  return `<span class="hist-chip ${cls}">${arrow} ${Math.abs(d.pct).toFixed(1)}%</span>`;
}
function histStatCard(label, valStr, d, dir) {
  return `<div class="ads-stat"><div class="ads-stat-v">${valStr}</div><div class="ads-stat-l">${escapeHtml(label)}</div>${histDeltaChip(d, dir)}</div>`;
}
function renderHistStats(res) {
  const a = res.actual, dl = res.deltas, cur = 'ARS';
  $('#histStats').innerHTML = [
    histStatCard('Gasto', adsMoney(a.gasto, cur), dl.gasto, 'neutral'),
    histStatCard('Impresiones', adsInt(a.impresiones), dl.impresiones, 'up'),
    histStatCard('Clics', adsInt(a.clics), dl.clics, 'up'),
    histStatCard('CTR', a.ctr != null ? a.ctr.toFixed(2) + '%' : '—', dl.ctr, 'up'),
    histStatCard('Consultas', a.consultas != null ? adsInt(a.consultas) : '—', dl.consultas, 'up'),
    histStatCard('Ventas', a.ventas != null ? adsInt(a.ventas) : '—', dl.ventas, 'up'),
    histStatCard('Costo/consulta', a.costoConsulta != null ? adsMoney(a.costoConsulta, cur) : '—', dl.costoConsulta, 'down'),
  ].join('');
}

function histRow(label, actStr, antStr, d, dir) {
  return `<div class="hist-trow"><span class="hist-tl">${escapeHtml(label)}</span><span class="hist-ta">${actStr}</span><span class="hist-tb">${antStr}</span><span class="hist-tdd">${histDeltaChip(d, dir)}</span></div>`;
}
function renderHistTable(res) {
  const a = res.actual, b = res.anterior, dl = res.deltas, cur = 'ARS';
  const money = (n) => (n != null ? adsMoney(n, cur) : '—');
  const intf = (n) => (n != null ? adsInt(n) : '—');
  const pctf = (n) => (n != null ? n.toFixed(2) + '%' : '—');
  const head = `<div class="hist-trow hist-thead"><span class="hist-tl">Métrica</span><span class="hist-ta">Actual</span><span class="hist-tb">Anterior</span><span class="hist-tdd">Δ</span></div>`;
  const rows = [
    histRow('Gasto total', money(a.gasto), money(b.gasto), dl.gasto, 'neutral'),
    histRow('Impresiones', intf(a.impresiones), intf(b.impresiones), dl.impresiones, 'up'),
    histRow('Clics', intf(a.clics), intf(b.clics), dl.clics, 'up'),
    histRow('CTR', pctf(a.ctr), pctf(b.ctr), dl.ctr, 'up'),
    histRow('Resultados (Meta)', intf(a.resultados), intf(b.resultados), dl.resultados, 'up'),
    histRow('Consultas', intf(a.consultas), intf(b.consultas), dl.consultas, 'up'),
    histRow('Ventas', intf(a.ventas), intf(b.ventas), dl.ventas, 'up'),
    histRow('CVR', pctf(a.cvr), pctf(b.cvr), dl.cvr, 'up'),
    histRow('Costo por consulta', money(a.costoConsulta), money(b.costoConsulta), dl.costoConsulta, 'down'),
    histRow('Costo por venta', money(a.costoVenta), money(b.costoVenta), dl.costoVenta, 'down'),
  ];
  $('#histTable').innerHTML = head + rows.join('');
}

function renderHistChannels(res) {
  const a = res.actual, cur = 'ARS';
  const chans = [{ name: 'Meta Ads', d: a.meta }, { name: 'Google Ads', d: a.google }];
  const tot = a.gasto || 0;
  $('#histChannels').innerHTML = chans.map((ch) => {
    const ctr = ch.d.impresiones ? (ch.d.clics / ch.d.impresiones) * 100 : 0;
    return `<div class="ads-camp">
      <div class="ads-camp-head">
        <span class="ads-camp-name">${escapeHtml(ch.name)}</span>
        <span class="ads-camp-right"><strong>${adsMoney(ch.d.gasto, cur)}</strong></span>
      </div>
      <div class="ads-camp-metrics">
        <span>${adsInt(ch.d.impresiones)} impres. · ${adsInt(ch.d.clics)} clics · CTR ${ctr.toFixed(1)}%</span>
        <span>${tot ? (ch.d.gasto / tot * 100).toFixed(0) + '% del gasto' : ''}</span>
      </div>
    </div>`;
  }).join('');
}

function renderHistNote(res) {
  const notes = [];
  if (res.windows.clamped) notes.push('El período anterior se recortó al largo del período calendario anterior (por eso puede tener menos días).');
  const cov = res.coverage || {};
  if (cov.firstConsultaDay) notes.push('Consultas/ventas registradas desde ' + histFmtDate(cov.firstConsultaDay) + ' (antes de esa fecha no hay dato: el bot de WhatsApp no guarda historia diaria).');
  else notes.push('Todavía no hay consultas/ventas en el historial (se registran día a día desde que usás la app; Meta/Google sí se pueden reconstruir hacia atrás).');
  notes.push('El alcance no se incluye (no es sumable entre días). Gasto en ARS.');
  $('#histNote').innerHTML = notes.map((n) => '• ' + escapeHtml(n)).join('<br>');
}

function histBucketLabel(key, gran, i) {
  if (!key) return String(i + 1);
  const p = key.split('-');
  if (gran === 'month') return ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'][Number(p[1]) - 1] + ' ' + p[0].slice(2);
  return p[2] + '/' + p[1];
}
function renderHistChart(res) {
  destroyHistCharts();
  if (typeof Chart === 'undefined') return;
  const metric = histState.metric || 'gasto';
  const s = (res.series && res.series[metric]) || { actual: [], anterior: [] };
  const n = Math.max(s.actual.length, s.anterior.length);
  const labels = [], actData = [], antData = [];
  for (let i = 0; i < n; i++) {
    labels.push(histBucketLabel(s.actual[i] && s.actual[i].key, res.gran, i));
    actData.push(s.actual[i] ? s.actual[i].value : null);
    antData.push(s.anterior[i] ? s.anterior[i].value : null);
  }
  $('#histMetricTabs').dataset.name = HIST_METRIC_NAME[metric] || '';
  const opts = adsChartOpts();
  opts.plugins.legend.display = true;
  histCharts.push(new Chart($('#histChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Actual', data: actData, backgroundColor: '#4c8bf5', borderRadius: 4 },
        { label: 'Anterior', data: antData, backgroundColor: 'rgba(154,163,178,0.45)', borderRadius: 4 },
      ],
    },
    options: opts,
  }));
}

async function histUpdateNow() {
  const btn = $('#histUpdate'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Actualizando…';
  histShowSaveWarning(false);
  let r;
  try { r = await window.api.histUpdate(); await renderHist(); } catch (_) {}
  if (r && r.saved === false) histShowSaveWarning(true);
  btn.disabled = false; btn.textContent = old;
}
async function histRebuildNow() {
  const ok = await adsConfirm({
    title: 'Reconstruir historial',
    message: 'Voy a traer de Meta y Google el historial diario de los últimos ~24 meses (puede tardar un minuto). Sólo lee datos, no gasta plata ni modifica campañas. ¿Seguir?',
    okLabel: 'Reconstruir',
  });
  if (!ok) return;
  const btn = $('#histRebuild'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Reconstruyendo…';
  histShowSaveWarning(false);
  let r;
  try { r = await window.api.histRebuild({ months: 24 }); await renderHist(); } catch (_) {}
  if (r && r.saved === false) histShowSaveWarning(true);
  btn.disabled = false; btn.textContent = old;
}
async function histOpenSheet() {
  try { const r = await window.api.histOpen(); if (r && !r.ok) console.error('[hist] abrir hoja:', r.error); } catch (e) { console.error('[hist] abrir hoja:', e && e.message); }
}

let adsPlatformFilter = 'all';
let adsLastOverview = null;
let adsMultiAccount = false;
let adsAccountFilter = 'all';
const ADS_PLAT_DISPLAY = [
  { key: 'facebook', label: 'Facebook', emoji: '📘' },
  { key: 'instagram', label: 'Instagram', emoji: '📷' },
  { key: 'messenger', label: 'Messenger', emoji: '💬' },
  { key: 'audience_network', label: 'Audience Network', emoji: '🌐' },
  { key: 'other', label: 'Otros', emoji: '•' },
];
function adsPlatMetric(map, key) { return (map && map[key]) || { spend: 0, impressions: 0, clicks: 0, results: {} }; }

function setAdsView(which) {
  $('#adsSetup').hidden = which !== 'setup';
  $('#adsOverview').hidden = which !== 'overview';
  $('#adsLoading').hidden = which !== 'loading';
}

async function loadAds() {
  setAdsView('loading');
  let status;
  try { status = await window.api.adsStatus(); } catch (_) { status = { connected: false }; }
  if (!status || !status.connected) { setAdsView('setup'); return; }
  await renderAdsOverview();
}

function adsMoney(n, cur) {
  const v = Number(n) || 0;
  try { return new Intl.NumberFormat('es-AR', { style: 'currency', currency: cur || 'ARS', maximumFractionDigits: 2 }).format(v); }
  catch (_) { return '$' + v.toFixed(2); }
}
function adsInt(n) { return new Intl.NumberFormat('es-AR').format(Math.round(Number(n) || 0)); }

function adsResultsText(results) {
  const map = [['compras', 'compras'], ['leads', 'clientes pot.'], ['mensajes', 'mensajes'], ['registros', 'registros'], ['linkClicks', 'clics'], ['interacciones', 'interacc.']];
  const parts = [];
  for (const [k, lbl] of map) if (results && results[k] > 0) parts.push(adsInt(results[k]) + ' ' + lbl);
  return parts.length ? parts.join(' · ') : '—';
}

function adsStatusLabel(s) {
  const map = { PAUSED: 'Pausada', CAMPAIGN_PAUSED: 'Pausada', ADSET_PAUSED: 'Pausada', ARCHIVED: 'Archivada', DELETED: 'Eliminada', IN_PROCESS: 'En proceso', WITH_ISSUES: 'Con problemas', PENDING_REVIEW: 'En revisión', DISAPPROVED: 'Rechazada', PENDING_BILLING_INFO: 'Falta pago' };
  return map[s] || (s || 'Inactiva');
}
function adsObjectiveLabel(o) {
  const map = { OUTCOME_SALES: 'Ventas', OUTCOME_LEADS: 'Clientes potenciales', OUTCOME_ENGAGEMENT: 'Interacción', OUTCOME_AWARENESS: 'Reconocimiento', OUTCOME_TRAFFIC: 'Tráfico', OUTCOME_APP_PROMOTION: 'Promoción de app' };
  return map[o] || (o || 'Campaña');
}

function adsTotalCard(label, t, cur) {
  t = t || {};
  const impressions = Number(t.impressions) || 0;
  const clicks = Number(t.clicks) || 0;
  const ctrVal = impressions ? (clicks / impressions) * 100 : 0;
  const ctr = ctrVal ? ' · CTR ' + ctrVal.toFixed(1) + '%' : '';
  return `<div class="ads-card">
    <div class="ads-card-label">${label}</div>
    <div class="ads-card-spend">${adsMoney(t.spend, cur)}</div>
    <div class="ads-card-sub">${adsInt(impressions)} impres. · ${adsInt(clicks)} clics${ctr}</div>
    <div class="ads-card-sub">${adsResultsText(t.results)}</div>
  </div>`;
}

function adsCampaignActionBtn(c) {
  if (c.running) return `<button type="button" class="btn-small ads-act" data-ads-action="pause" data-camp-id="${c.id}">⏸ Pausar</button>`;
  if (['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'].includes(c.effectiveStatus)) {
    return `<button type="button" class="btn-small ads-act" data-ads-action="activate" data-camp-id="${c.id}">▶ Activar</button>`;
  }
  return '';
}

function adsCampaignRow(c, cur, filter) {
  filter = filter || 'all';
  const ccur = c.accountCurrency || cur; // cada campaña se muestra en la moneda de su cuenta
  const t7 = filter === 'all' ? (c.last7 || {}) : adsPlatMetric(c.last7ByPlatform, filter);
  const today = filter === 'all' ? (c.today || null) : adsPlatMetric(c.todayByPlatform, filter);
  const badge = c.running
    ? '<span class="ads-badge on">● Activa</span>'
    : '<span class="ads-badge off">⏸ ' + escapeHtml(adsStatusLabel(c.effectiveStatus)) + '</span>';
  const budget = c.dailyBudget ? ' · Presup. diario ' + adsMoney(c.dailyBudget, ccur) : '';
  const accTag = (adsMultiAccount && adsAccountFilter === 'all' && c.accountName) ? ' · 🏢 ' + escapeHtml(c.accountName) : '';
  const todayLine = (today && Number(today.spend) > 0)
    ? 'Hoy: ' + adsMoney(today.spend, ccur) + ' · ' + adsResultsText(today.results)
    : 'Hoy: sin gasto';
  // Desglose Facebook/Instagram (solo en la vista "Todas"), de los últimos 7 días
  let desglose = '';
  if (filter === 'all') {
    const plats = c.last7ByPlatform || {};
    const lines = ADS_PLAT_DISPLAY
      .filter((p) => plats[p.key] && (Number(plats[p.key].spend) > 0 || Number(plats[p.key].impressions) > 0))
      .map((p) => `<span>${p.emoji} ${p.label}: ${adsMoney(plats[p.key].spend, ccur)} · ${adsInt(plats[p.key].impressions)} impres. · ${adsResultsText(plats[p.key].results)}</span>`);
    if (lines.length) desglose = `<div class="ads-camp-platforms">${lines.join('')}</div>`;
  }
  // Comparación con objetivos (siempre a 30 días, sobre todas las plataformas)
  const objBlock = adsObjCompareBlock(c, ccur);
  const nameTitle = c.alias ? ' title="Nombre real en Meta: ' + escapeHtml(c.name || '') + '"' : '';
  return `<div class="ads-camp${c.running ? ' on' : ''}">
    <div class="ads-camp-head">
      <span class="ads-camp-name-wrap">
        <span class="ads-camp-name"${nameTitle}>${escapeHtml(c.displayName || c.name || '(sin nombre)')}</span>
        <button type="button" class="ads-alias-btn" data-ads-alias="${escapeHtml(c.id)}" title="Renombrar solo acá (no cambia Meta)">✏️</button>
        <button type="button" class="ads-alias-btn" data-ads-obj="${escapeHtml(c.id)}" title="Objetivos de la campaña">🎯</button>
      </span>
      <span class="ads-camp-right">${badge}${adsCampaignActionBtn(c)}</span>
    </div>
    <div class="ads-camp-meta">${escapeHtml(adsObjectiveLabel(c.objective))}${budget}${accTag}</div>
    <div class="ads-camp-metrics">
      <span>${todayLine}</span>
      <span>7 días: ${adsMoney(t7.spend, ccur)} · ${adsInt(t7.impressions)} impres. · ${adsResultsText(t7.results)}</span>
    </div>
    ${desglose}
    ${objBlock}
  </div>`;
}

// ---- Objetivos de campaña (metas locales que se comparan con las métricas reales) ----
// Resultado principal (misma prioridad que Meta): compras > leads > mensajes > registros > clics > interacc.
function adsPrimaryResultValue(results) {
  const order = ['compras', 'leads', 'mensajes', 'registros', 'linkClicks', 'interacciones'];
  for (const k of order) if (results && Number(results[k]) > 0) return Number(results[k]);
  return 0;
}
// dir 'min' = meta a alcanzar o superar · dir 'max' = tope que conviene no pasar (gasto)
// actual recibe (t = métricas de 30 días sumadas, c = campaña completa). El alcance usa el valor
// ÚNICO real (c.reach30, deduplicado por Meta); solo cae a la suma diaria si no se pudo traer.
const ADS_OBJ_METRICS = [
  { key: 'results', label: 'Resultados', fmt: 'int', dir: 'min', actual: (t) => adsPrimaryResultValue(t.results) },
  { key: 'ctr', label: 'CTR', fmt: 'pct', dir: 'min', actual: (t) => (Number(t.impressions) ? (Number(t.clicks) / Number(t.impressions)) * 100 : 0) },
  { key: 'reach', label: 'Alcance', fmt: 'int', dir: 'min', actual: (t, c) => Number(c && c.reach30 != null ? c.reach30 : (t.reach || 0)) },
  { key: 'impressions', label: 'Impresiones', fmt: 'int', dir: 'min', actual: (t) => Number(t.impressions) || 0 },
  { key: 'spend', label: 'Gasto', fmt: 'money', dir: 'max', actual: (t) => Number(t.spend) || 0 },
];
function adsObjFmt(v, fmt, cur) {
  if (fmt === 'money') return adsMoney(v, cur);
  if (fmt === 'pct') return (Number(v) || 0).toFixed(1) + '%';
  return adsInt(v);
}
// Devuelve el HTML del bloque de comparación, o '' si la campaña no tiene objetivos cargados
function adsObjCompareBlock(c, cur) {
  const obj = c.objectives;
  if (!obj || typeof obj !== 'object') return '';
  const t = c.last30 || {};
  const rows = [];
  for (const m of ADS_OBJ_METRICS) {
    const target = Number(obj[m.key]);
    if (!(target > 0)) continue;
    const actual = m.actual(t, c);
    const ok = m.dir === 'max' ? actual <= target : actual >= target;
    const pct = target ? Math.round((actual / target) * 100) : 0;
    const icon = ok ? '✅' : '❌';
    const cls = ok ? 'ads-obj-ok' : 'ads-obj-bad';
    const word = m.dir === 'max' ? 'tope' : 'meta';
    rows.push(`<span class="ads-obj-row ${cls}">${icon} ${m.label}: <strong>${adsObjFmt(actual, m.fmt, cur)}</strong> / ${word} ${adsObjFmt(target, m.fmt, cur)} <small>(${pct}%)</small></span>`);
  }
  if (!rows.length) return '';
  return `<div class="ads-camp-obj"><span class="ads-obj-title">🎯 Objetivos · últimos 30 días</span>${rows.join('')}</div>`;
}

// Editor de alias (nombre local para mostrar)
let adsAliasEditingId = null;
function openAliasEditor(campaignId) {
  const c = adsCampaignsById[campaignId];
  if (!c) return;
  adsAliasEditingId = campaignId;
  $('#adsAliasReal').textContent = 'Nombre real en Meta: ' + (c.name || '(sin nombre)');
  $('#adsAliasInput').value = c.alias || '';
  $('#adsAliasModal').hidden = false;
  setTimeout(() => { try { $('#adsAliasInput').focus(); $('#adsAliasInput').select(); } catch (_) {} }, 40);
}
function closeAliasEditor() { $('#adsAliasModal').hidden = true; adsAliasEditingId = null; }
async function saveAlias(alias) {
  const id = adsAliasEditingId;
  if (!id) return;
  try {
    const res = await window.api.adsSetAlias({ campaignId: id, alias });
    closeAliasEditor();
    if (res && res.ok && res.overview) await renderAdsOverview(res.overview);
    else await renderAdsOverview();
  } catch (_) { closeAliasEditor(); }
}

// Editor de objetivos (metas locales por campaña)
let adsObjEditingId = null;
function openObjEditor(campaignId) {
  const c = adsCampaignsById[campaignId];
  if (!c) return;
  adsObjEditingId = campaignId;
  const o = c.objectives || {};
  $('#adsObjCamp').textContent = 'Campaña: ' + (c.displayName || c.name || '(sin nombre)');
  $('#adsObjCur').textContent = c.accountCurrency || adsCurrency || 'ARS';
  $('#adsObjResults').value = o.results || '';
  $('#adsObjCtr').value = o.ctr || '';
  $('#adsObjReach').value = o.reach || '';
  $('#adsObjImpr').value = o.impressions || '';
  $('#adsObjSpend').value = o.spend || '';
  $('#adsObjModal').hidden = false;
  setTimeout(() => { try { $('#adsObjResults').focus(); $('#adsObjResults').select(); } catch (_) {} }, 40);
}
function closeObjEditor() { $('#adsObjModal').hidden = true; adsObjEditingId = null; }
async function saveObjectives(clear) {
  const id = adsObjEditingId;
  if (!id) return;
  const objectives = clear ? {} : {
    results: $('#adsObjResults').value,
    ctr: $('#adsObjCtr').value,
    reach: $('#adsObjReach').value,
    impressions: $('#adsObjImpr').value,
    spend: $('#adsObjSpend').value,
  };
  try {
    const res = await window.api.adsSetObjectives({ campaignId: id, objectives });
    closeObjEditor();
    if (res && res.ok && res.overview) await renderAdsOverview(res.overview);
    else await renderAdsOverview();
  } catch (_) { closeObjEditor(); }
}

// Click en ✏️ Renombrar / Pausar / Activar (delegado en el contenedor de campañas)
async function onAdsCampaignClick(e) {
  const aliasBtn = e.target.closest('[data-ads-alias]');
  if (aliasBtn) { openAliasEditor(aliasBtn.dataset.adsAlias); return; }
  const objBtn = e.target.closest('[data-ads-obj]');
  if (objBtn) { openObjEditor(objBtn.dataset.adsObj); return; }
  const btn = e.target.closest('[data-ads-action]');
  if (!btn) return;
  const id = btn.dataset.campId;
  const action = btn.dataset.adsAction;
  const c = adsCampaignsById[id];
  if (!c) return;
  const cur = adsCurrency || 'ARS';
  const toActive = action === 'activate';
  const budgetTxt = (toActive && c.dailyBudget) ? ' Va a gastar su presupuesto de ' + adsMoney(c.dailyBudget, cur) + ' por día.' : '';
  const ok = await adsConfirm({
    title: toActive ? 'Activar campaña' : 'Pausar campaña',
    message: toActive
      ? `Vas a ACTIVAR «${c.name}».${budgetTxt}\n\nVa a empezar a gastar plata real. ¿Confirmás?`
      : `Vas a PAUSAR «${c.name}».\n\nDeja de mostrarse y de gastar. ¿Confirmás?`,
    okLabel: toActive ? 'Sí, activar' : 'Sí, pausar',
    danger: toActive,
  });
  if (!ok) return;
  btn.disabled = true; btn.textContent = toActive ? 'Activando…' : 'Pausando…';
  try {
    const res = await window.api.adsSetStatus({ campaignId: id, status: toActive ? 'ACTIVE' : 'PAUSED' });
    if (!res.ok) { adsShowError(res.error); btn.disabled = false; return; }
    await renderAdsOverview(res.overview);
  } catch (err) {
    adsShowError((err && err.message) || String(err));
    btn.disabled = false;
  }
}

// --- Promocionar una publicación (Fase 3) ---
let adsBoostPosts = [];
let adsBoostSelectedId = null;

async function loadBoostPosts() {
  const btn = $('#adsBoostLoad');
  const msg = $('#adsBoostMsg'); msg.hidden = true;
  btn.disabled = true; btn.textContent = 'Cargando…';
  try {
    const res = await window.api.adsListPosts();
    if (!res.ok) { msg.className = 'warn-line'; msg.textContent = res.error; msg.hidden = false; return; }
    adsBoostPosts = res.posts || [];
    renderBoostPosts();
    $('#adsBoostPosts').hidden = false;
  } catch (e) {
    msg.className = 'warn-line'; msg.textContent = 'No se pudieron cargar las publicaciones: ' + ((e && e.message) || e); msg.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = adsBoostPosts.length ? 'Actualizar lista' : 'Elegir una publicación…';
  }
}

function renderBoostPosts() {
  const list = $('#adsBoostPosts');
  if (!adsBoostPosts.length) { list.innerHTML = '<p class="hint">No encontré publicaciones recientes en tu Página.</p>'; return; }
  list.innerHTML = adsBoostPosts.map((p) => {
    const sel = p.id === adsBoostSelectedId ? ' sel' : '';
    const img = p.picture ? `<img src="${escapeHtml(p.picture)}" alt="" />` : '';
    const date = p.createdTime ? formatDate(new Date(p.createdTime).getTime()) : '';
    return `<div class="ads-post${sel}" data-post-id="${escapeHtml(p.id)}">
      ${img}
      <div>
        <div class="ads-post-msg">${escapeHtml(p.message)}</div>
        <div class="ads-post-date">${escapeHtml(date)}</div>
      </div>
    </div>`;
  }).join('');
}

function onBoostPostClick(e) {
  const el = e.target.closest('[data-post-id]');
  if (!el) return;
  adsBoostSelectedId = el.dataset.postId;
  renderBoostPosts();
  $('#adsBoostForm').hidden = false;
}

async function createBoostNow() {
  const msg = $('#adsBoostMsg'); msg.hidden = true;
  const post = adsBoostPosts.find((p) => p.id === adsBoostSelectedId);
  if (!post) { msg.className = 'warn-line'; msg.textContent = 'Elegí una publicación.'; msg.hidden = false; return; }
  const budget = Number($('#adsBoostBudget').value);
  const days = parseInt($('#adsBoostDays').value, 10) || 7;
  const objective = $('#adsBoostObjective').value;
  const cur = adsCurrency || 'ARS';
  if (!(budget > 0)) { msg.className = 'warn-line'; msg.textContent = 'Poné un presupuesto diario válido.'; msg.hidden = false; return; }
  const ok = await adsConfirm({
    title: 'Crear promoción (en pausa)',
    message: `Vas a crear una campaña EN PAUSA para promocionar esta publicación.\n\nPresupuesto: ${adsMoney(budget, cur)} por día · ${days} días.\n\nNO gasta nada hasta que la actives desde «Campañas». ¿Crear?`,
    okLabel: 'Crear en pausa',
  });
  if (!ok) return;
  const btn = $('#adsBoostCreate'); btn.disabled = true; btn.textContent = 'Creando…';
  try {
    const res = await window.api.adsCreateBoost({ postId: post.postId, dailyBudget: budget, days, objective });
    if (!res.ok) { msg.className = 'warn-line'; msg.textContent = res.error; msg.hidden = false; return; }
    adsBoostSelectedId = null;
    $('#adsBoostForm').hidden = true;
    $('#adsBoostPosts').hidden = true;
    if (res.overview) await renderAdsOverview(res.overview);
    const done = $('#adsBoostMsg');
    done.className = 'note';
    done.textContent = '✅ Campaña creada EN PAUSA. Aparece abajo en «Campañas»: revisala y tocá ▶ Activar cuando quieras que empiece a gastar.';
    done.hidden = false;
  } catch (e) {
    msg.className = 'warn-line'; msg.textContent = 'No se pudo crear: ' + ((e && e.message) || e); msg.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = 'Crear campaña (en pausa)';
  }
}

async function renderAdsOverview(pre) {
  setAdsView('loading');
  let ov = pre;
  if (!ov) { try { ov = await window.api.adsOverview(); } catch (_) { ov = null; } }
  if (!ov || !ov.connected) { setAdsView('setup'); return; }
  adsLastOverview = ov;
  renderAdsFromOverview(ov);
  renderAdsFunnel(); // embudo con consultas/ventas del Contador (cacheado, no bloquea)
}

// Re-dibuja desde el último overview cacheado (lo usa el filtro, sin volver a pedir datos)
function applyAdsFilter() {
  if (adsLastOverview) renderAdsFromOverview(adsLastOverview);
}

// ---- Embudo: Impresiones (Meta) → Consultas (WhatsApp) → Ventas (Contador de Consultas) ----
let adsConsultasCache = null; // { at, data }
async function renderAdsFunnel(force) {
  const box = $('#adsFunnelBox');
  if (!box || !adsLastOverview) return;
  let f = (!force && adsConsultasCache && (Date.now() - adsConsultasCache.at < 60000)) ? adsConsultasCache.data : null;
  if (!f) {
    box.innerHTML = '<p class="hint">Cargando consultas…</p>';
    try { f = await window.api.adsGetConsultas(); } catch (_) { f = { ok: false }; }
    adsConsultasCache = { at: Date.now(), data: f };
  }
  if ($('#adsModal').hidden) return; // cambió de vista mientras cargaba
  if (!f || !f.ok) {
    box.innerHTML = `<p class="hint">${f && f.offline
      ? '🔌 Abrí el <strong>Contador de Consultas</strong> en esta PC para ver cuántas consultas y ventas generan tus anuncios.'
      : '⚠️ ' + escapeHtml((f && f.error) || 'No se pudo leer el Contador de Consultas.')}<br>El embudo cruza las impresiones de Meta con las consultas de WhatsApp.</p>`;
    return;
  }
  const ov = adsLastOverview;
  const cur = ov.currency || adsCurrency || 'ARS';
  const showCosts = !ov.mixedCurrency;
  const cards = [
    ['Últimos 7 días', ov.last7 || {}, f.last7 || {}],
    ['Últimos 30 días', ov.last30 || {}, f.last30 || {}],
  ].map(([lbl, meta, con]) => adsFunnelCard(lbl, meta, con, cur, showCosts)).join('');
  const nota = '<p class="hint">Las consultas de WhatsApp no se atan a una campaña puntual: el embudo es del <strong>total de la cuenta</strong> (todas las plataformas). «Consultas» = personas únicas que escribieron por publicidad.</p>';
  box.innerHTML = `<div class="ads-funnel-cards">${cards}</div>` + nota + (f.updatedAt ? `<p class="hint">Consultas al: ${escapeHtml(f.updatedAt)}</p>` : '');
}

function adsFunnelCard(label, meta, con, cur, showCosts) {
  const impr = Number(meta.impressions) || 0;
  const spend = Number(meta.spend) || 0;
  const consultas = Number(con.consultas) || 0;
  const ventas = Number(con.ventas) || 0;
  const cvr = con.cvr != null ? Number(con.cvr) : (consultas ? (ventas / consultas) * 100 : 0);
  const imprPorConsulta = consultas ? Math.round(impr / consultas) : 0;
  const pctConsultas = impr ? (consultas / impr) * 100 : 0;
  const costoConsulta = consultas ? spend / consultas : 0;
  const costoVenta = ventas ? spend / ventas : 0;
  const costos = (showCosts && spend > 0)
    ? `<div class="ads-funnel-costs">Costo por consulta: <strong>${consultas ? adsMoney(costoConsulta, cur) : '—'}</strong> · por venta: <strong>${ventas ? adsMoney(costoVenta, cur) : '—'}</strong></div>`
    : '';
  return `<div class="ads-funnel-card">
    <div class="ads-funnel-title">${label}</div>
    <div class="ads-funnel-step"><span class="ads-funnel-k">👁️ Impresiones</span><span class="ads-funnel-v">${adsInt(impr)}</span></div>
    <div class="ads-funnel-link">${consultas ? '1 consulta cada <strong>' + adsInt(imprPorConsulta) + '</strong> impresiones · ' + pctConsultas.toFixed(2) + '%' : 'sin consultas en el período'}</div>
    <div class="ads-funnel-step"><span class="ads-funnel-k">💬 Consultas</span><span class="ads-funnel-v">${adsInt(consultas)}</span></div>
    <div class="ads-funnel-link">conversión (CVR) <strong>${cvr.toFixed(1)}%</strong></div>
    <div class="ads-funnel-step"><span class="ads-funnel-k">🛒 Ventas</span><span class="ads-funnel-v">${adsInt(ventas)}</span></div>
    ${costos}
  </div>`;
}

// ---- Informe: demografía (edad/género/ubicación) + rendimiento con gráficos (Chart.js) ----
let adsReportCharts = [];
const ADS_CHART_COLORS = ['#4c8bf5', '#2EC4B6', '#E84A6F', '#E9B949', '#B87333', '#9b8cff', '#6ee7d8', '#f5a05a', '#7bd389', '#ef8fb3'];
function destroyReportCharts() { for (const ch of adsReportCharts) { try { ch.destroy(); } catch (_) {} } adsReportCharts = []; }
function adsGenderLabel(g) { const m = { male: 'Hombres', female: 'Mujeres', unknown: 'Sin dato' }; return m[String(g).toLowerCase()] || g; }

async function openReport() {
  if (typeof Chart === 'undefined') { alert('No se pudo cargar la librería de gráficos.'); return; }
  const modal = $('#adsReportModal');
  $('#adsReportContent').hidden = true;
  const msg = $('#adsReportMsg'); msg.hidden = false; msg.textContent = 'Cargando informe (puede tardar unos segundos)…';
  modal.hidden = false;
  let rep;
  try { rep = await window.api.adsGetReport({ accountId: adsAccountFilter }); } catch (_) { rep = { ok: false }; }
  if (modal.hidden) return; // lo cerraron mientras cargaba
  if (!rep || !rep.ok) { msg.textContent = '⚠️ ' + ((rep && rep.error) || 'No se pudo generar el informe.'); return; }
  msg.hidden = true;
  $('#adsReportContent').hidden = false;
  $('#adsReportRange').textContent = 'Período: ' + rep.since + ' → ' + rep.until + (adsAccountFilter !== 'all' ? ' · una cuenta' : ' · todas las cuentas');
  try { Chart.defaults.color = '#9aa3b2'; } catch (_) {}
  renderReportStats(rep);
  renderReportCharts(rep);
}
function closeReport() { destroyReportCharts(); $('#adsReportModal').hidden = true; }

function adsStatCard(label, val) {
  return `<div class="ads-stat"><div class="ads-stat-v">${val}</div><div class="ads-stat-l">${escapeHtml(label)}</div></div>`;
}
function renderReportStats(rep) {
  const t = (adsLastOverview && adsLastOverview.last30) || {};
  const f = rep.funnel && rep.funnel.ok ? rep.funnel.last30 : null;
  const cards = [
    adsStatCard('Impresiones (30d)', adsInt(t.impressions || 0)),
    adsStatCard('Alcance (30d)', adsInt(t.reach || 0)),
    adsStatCard('Clics (30d)', adsInt(t.clicks || 0)),
    adsStatCard('CTR (30d)', (t.impressions ? (t.clicks / t.impressions) * 100 : 0).toFixed(2) + '%'),
  ];
  if (f) {
    cards.push(adsStatCard('Consultas', adsInt(f.consultas)));
    cards.push(adsStatCard('Ventas', adsInt(f.ventas)));
    cards.push(adsStatCard('CVR (conversión)', (Number(f.cvr) || 0).toFixed(1) + '%'));
  }
  $('#adsReportStats').innerHTML = cards.join('');
}

function adsChartOpts(kind) {
  const dim = '#9aa3b2', grid = 'rgba(255,255,255,0.07)';
  const base = { responsive: true, maintainAspectRatio: true, interaction: { intersect: false, mode: 'index' },
    plugins: { legend: { display: false, labels: { color: dim, boxWidth: 12, font: { size: 11 } } } } };
  if (kind === 'pie') { base.plugins.legend = { display: true, position: 'bottom', labels: { color: dim, boxWidth: 12, font: { size: 11 } } }; return base; }
  if (kind === 'horizontal') {
    base.indexAxis = 'y';
    base.scales = { x: { ticks: { color: dim }, grid: { color: grid } }, y: { ticks: { color: dim, font: { size: 10 } }, grid: { display: false } } };
    return base;
  }
  if (kind === 'dual') {
    base.plugins.legend.display = true;
    base.scales = {
      x: { ticks: { color: dim, maxTicksLimit: 10, maxRotation: 0 }, grid: { display: false } },
      y: { position: 'left', beginAtZero: true, ticks: { color: dim }, grid: { color: grid } },
      y1: { position: 'right', beginAtZero: true, ticks: { color: dim }, grid: { display: false } },
    };
    return base;
  }
  base.scales = { x: { ticks: { color: dim }, grid: { color: grid } }, y: { beginAtZero: true, ticks: { color: dim }, grid: { color: grid } } };
  return base;
}

function adsPct(n) { return (Number(n) || 0).toFixed(1).replace('.', ',') + '%'; }
// Lista de texto copiable: "Etiqueta: X,X% · N impres." (o CTR). `total` opcional (para % sobre el gran total).
function adsDistRows(list, opts) {
  opts = opts || {};
  const tot = opts.total != null ? opts.total : list.reduce((s, x) => s + (Number(x.impressions) || 0), 0);
  if (!tot) return '<span class="hint">Sin datos en el período.</span>';
  const rows = list.map((x) => {
    const share = adsPct((Number(x.impressions) || 0) / tot * 100);
    const extra = opts.withCtr ? 'CTR ' + adsPct(x.ctr) : adsInt(x.impressions) + ' impres.';
    return `<div class="ads-dist-row">${escapeHtml(x.label)}: <strong>${share}</strong> <small>· ${extra}</small></div>`;
  });
  if (opts.otras != null && opts.otras > 0) {
    rows.push(`<div class="ads-dist-row">Otras: <strong>${adsPct(opts.otras / tot * 100)}</strong> <small>· ${adsInt(opts.otras)} impres.</small></div>`);
  }
  return rows.join('');
}

function renderReportCharts(rep) {
  destroyReportCharts();
  // 1) Tendencia diaria: impresiones + alcance (eje izq) y CTR % (eje der)
  const tr = rep.trend || [];
  adsReportCharts.push(new Chart($('#adsChartTrend'), {
    type: 'line',
    data: {
      labels: tr.map((d) => d.day.slice(5)),
      datasets: [
        { label: 'Impresiones', data: tr.map((d) => d.impressions), borderColor: '#4c8bf5', backgroundColor: 'transparent', yAxisID: 'y', tension: 0.3, pointRadius: 0, borderWidth: 2 },
        { label: 'Alcance', data: tr.map((d) => d.reach), borderColor: '#2EC4B6', backgroundColor: 'transparent', yAxisID: 'y', tension: 0.3, pointRadius: 0, borderWidth: 2 },
        { label: 'CTR %', data: tr.map((d) => Number(d.ctr.toFixed(2))), borderColor: '#E9B949', backgroundColor: 'transparent', yAxisID: 'y1', tension: 0.3, pointRadius: 0, borderWidth: 2, borderDash: [4, 3] },
      ],
    },
    options: adsChartOpts('dual'),
  }));
  // 2) Género (doughnut, por impresiones)
  const g = rep.gender || [];
  adsReportCharts.push(new Chart($('#adsChartGender'), {
    type: 'doughnut',
    data: { labels: g.map((x) => adsGenderLabel(x.label)), datasets: [{ data: g.map((x) => x.impressions), backgroundColor: ADS_CHART_COLORS, borderColor: '#1b1e26', borderWidth: 2 }] },
    options: adsChartOpts('pie'),
  }));
  // 3) Edad: impresiones (barras) + CTR % (línea)
  const a = (rep.age || []).filter((x) => String(x.label).toLowerCase() !== 'unknown');
  adsReportCharts.push(new Chart($('#adsChartAge'), {
    type: 'bar',
    data: {
      labels: a.map((x) => x.label),
      datasets: [
        { label: 'Impresiones', data: a.map((x) => x.impressions), backgroundColor: '#4c8bf5', yAxisID: 'y', borderRadius: 4 },
        { label: 'CTR %', type: 'line', data: a.map((x) => Number(x.ctr.toFixed(2))), borderColor: '#E9B949', backgroundColor: 'transparent', yAxisID: 'y1', tension: 0.3, borderWidth: 2 },
      ],
    },
    options: adsChartOpts('dual'),
  }));
  // 4) Ubicación: top provincias por impresiones (barras horizontales)
  const r = (rep.region || []).slice(0, 10);
  adsReportCharts.push(new Chart($('#adsChartRegion'), {
    type: 'bar',
    data: { labels: r.map((x) => x.label), datasets: [{ label: 'Impresiones', data: r.map((x) => x.impressions), backgroundColor: '#2EC4B6', borderRadius: 4 }] },
    options: adsChartOpts('horizontal'),
  }));
  // Listas de % copiables bajo cada gráfico demográfico
  $('#adsDistGender').innerHTML = adsDistRows(g.map((x) => ({ ...x, label: adsGenderLabel(x.label) })));
  $('#adsDistAge').innerHTML = adsDistRows(a, { withCtr: true });
  const regionTotal = (rep.region || []).reduce((s, x) => s + (Number(x.impressions) || 0), 0);
  const shownTotal = r.reduce((s, x) => s + (Number(x.impressions) || 0), 0);
  $('#adsDistRegion').innerHTML = adsDistRows(r, { total: regionTotal, otras: regionTotal - shownTotal });
}

function renderAdsFromOverview(ov) {
  setAdsView('overview');
  const acc = ov.account || {};
  const accounts = ov.accounts || [];
  adsMultiAccount = accounts.length > 1;
  // Si la cuenta elegida ya no está, volver a "Todas"
  if (adsAccountFilter !== 'all' && !accounts.some((a) => a.id === adsAccountFilter)) adsAccountFilter = 'all';

  // Botones del selector de cuenta (solo cuando hay más de una)
  const accFilterEl = $('#adsAccountFilter');
  if (adsMultiAccount) {
    accFilterEl.hidden = false;
    accFilterEl.innerHTML = '<span class="ads-filter-label">Cuenta:</span>'
      + '<button type="button" class="ads-filter-btn' + (adsAccountFilter === 'all' ? ' active' : '') + '" data-acc="all">Todas</button>'
      + accounts.map((a) => '<button type="button" class="ads-filter-btn' + (adsAccountFilter === a.id ? ' active' : '') + '" data-acc="' + escapeHtml(a.id) + '">' + escapeHtml(a.name || a.id) + '</button>').join('');
  } else {
    accFilterEl.hidden = true;
    adsAccountFilter = 'all';
  }

  const selAcc = adsAccountFilter !== 'all' ? accounts.find((a) => a.id === adsAccountFilter) : null;
  $('#adsAccountName').textContent = selAcc
    ? (selAcc.name || 'Cuenta ' + selAcc.id)
    : (adsMultiAccount
      ? accounts.length + ' cuentas: ' + accounts.map((a) => a.name || a.id).join(', ')
      : (acc.name ? acc.name + ' · ' : '') + 'Cuenta ' + (acc.id || ''));
  $('#adsSyncAt').textContent = ov.lastSyncAt ? 'Última actualización: ' + formatDate(ov.lastSyncAt) : 'Todavía no se sincronizó';
  const err = $('#adsError');
  if (ov.lastError) { err.textContent = '⚠️ ' + ov.lastError; err.hidden = false; } else { err.hidden = true; }

  // Scope: una cuenta elegida o el combinado de todas
  const scope = (adsAccountFilter !== 'all' && ov.byAccount && ov.byAccount[adsAccountFilter]) ? ov.byAccount[adsAccountFilter] : ov;
  const cur = (selAcc && selAcc.currency) || ov.currency || acc.currency || 'ARS';
  const curLabel = $('#adsBoostCur'); if (curLabel) curLabel.textContent = cur;
  adsCurrency = cur;

  const filter = adsPlatformFilter;
  const bp = scope.byPlatform || {};
  const totals = filter === 'all'
    ? [['Hoy', scope.today], ['Ayer', scope.yesterday], ['Últimos 7 días', scope.last7], ['Últimos 30 días', scope.last30]]
    : [['Hoy', adsPlatMetric(bp.today, filter)], ['Ayer', adsPlatMetric(bp.yesterday, filter)], ['Últimos 7 días', adsPlatMetric(bp.last7, filter)], ['Últimos 30 días', adsPlatMetric(bp.last30, filter)]];
  $('#adsTotals').innerHTML = totals.map(([lbl, m]) => adsTotalCard(lbl, m, cur)).join('');

  // Mapa COMPLETO para las acciones (pausar/activar), sin importar el filtro
  adsCampaignsById = {};
  for (const c of (ov.campaigns || [])) adsCampaignsById[c.id] = c;

  // Campañas: primero por cuenta, después por plataforma
  let camps = ov.campaigns || [];
  if (adsAccountFilter !== 'all') camps = camps.filter((c) => c.accountId === adsAccountFilter);
  let note = '';
  if (filter !== 'all') {
    const before = camps.length;
    camps = camps.filter((c) => { const m = (c.last7ByPlatform || {})[filter]; return m && (Number(m.spend) > 0 || Number(m.impressions) > 0); });
    const hidden = before - camps.length;
    const lbl = filter === 'facebook' ? '📘 Facebook' : '📷 Instagram';
    note = `<p class="hint">Mostrando solo ${lbl}${hidden ? ` · ${hidden} campaña(s) sin actividad en esta red, ocultas` : ''}.</p>`;
  }
  const mixedNote = (ov.mixedCurrency && adsAccountFilter === 'all')
    ? '<p class="warn-line">⚠️ Tus cuentas usan monedas distintas: los totales combinados pueden no ser exactos. Elegí una cuenta arriba para ver sus números exactos.</p>'
    : '';
  $('#adsCampaigns').innerHTML = mixedNote + note + (camps.length
    ? camps.map((c) => adsCampaignRow(c, cur, filter)).join('')
    : '<p class="hint">' + (filter === 'all'
      ? 'No hay campañas activas o con gasto reciente. Si recién conectaste, esperá unos segundos y tocá 🔄 Actualizar.'
      : 'No hay campañas con actividad en esta red en los últimos 7 días.') + '</p>');

  renderAdsSchedules(ov.schedules || []);
}

// ---- Pausas programadas ----
const DOW_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function adsSchedWhenText(s) {
  const hh = String(s.hh).padStart(2, '0');
  const mm = String(s.mm).padStart(2, '0');
  if (s.type === 'weekly') return `Cada ${DOW_ES[Number(s.dow)] || '—'} a las ${hh}:${mm}`;
  const d = s.whenMs ? new Date(Number(s.whenMs)) : null;
  if (!d) return `A las ${hh}:${mm}`;
  return `El ${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()} a las ${hh}:${mm}`;
}
function renderAdsSchedules(schedules) {
  const box = $('#adsSchedList');
  if (!box) return;
  if (!schedules.length) { box.innerHTML = '<p class="hint">No hay pausas programadas.</p>'; return; }
  // vigentes primero (semanal o "una vez" sin ejecutar), después las ya ejecutadas
  const sorted = schedules.slice().sort((a, b) => {
    const ad = a.type === 'once' && a.done ? 1 : 0;
    const bd = b.type === 'once' && b.done ? 1 : 0;
    return ad - bd;
  });
  box.innerHTML = sorted.map((s) => {
    const spent = s.type === 'once' && s.done;
    const retrying = !!s.occAt; // ocurrencia en curso reintentando
    const estado = retrying
      ? `<span class="ads-sched-retry">⏳ ${escapeHtml(s.lastResult || 'Reintentando…')}</span>`
      : spent
        ? `<span class="ads-sched-done">✔ Ejecutada${s.lastResult ? ' · ' + escapeHtml(s.lastResult) : ''}</span>`
        : (s.lastResult ? `<span class="ads-sched-last">Última vez: ${escapeHtml(s.lastResult)}</span>` : '<span class="ads-sched-next">Pendiente</span>');
    return `<div class="ads-sched-row${spent ? ' spent' : ''}">
      <div class="ads-sched-info">
        <span class="ads-sched-when">${escapeHtml(adsSchedWhenText(s))}</span>
        <span class="ads-sched-target">${escapeHtml(s.targetName || 'Todas las activas')}</span>
        ${estado}
      </div>
      <button type="button" class="ads-sched-del" data-ads-sched-del="${escapeHtml(s.id)}" title="Eliminar">🗑</button>
    </div>`;
  }).join('');
}

function openSchedEditor() {
  // Poblar el desplegable de campañas con las activas (y "Todas")
  const sel = $('#adsSchedTarget');
  const running = Object.values(adsCampaignsById).filter((c) => c.running);
  sel.innerHTML = '<option value="ALL">Todas las campañas activas</option>'
    + running.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.displayName || c.name || c.id)}</option>`).join('');
  // Valores por defecto
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  $('#adsSchedDate').value = `${yyyy}-${mm}-${dd}`;
  $('#adsSchedDate').min = `${yyyy}-${mm}-${dd}`;
  $('#adsSchedTime').value = '23:59';
  const onceRadio = document.querySelector('input[name="adsSchedType"][value="once"]');
  if (onceRadio) onceRadio.checked = true;
  updateSchedType();
  const msg = $('#adsSchedMsg'); msg.hidden = true; msg.textContent = '';
  $('#adsSchedModal').hidden = false;
}
function closeSchedEditor() { $('#adsSchedModal').hidden = true; }
function updateSchedType() {
  const type = (document.querySelector('input[name="adsSchedType"]:checked') || {}).value || 'once';
  $('#adsSchedOnceRow').hidden = type !== 'once';
  $('#adsSchedWeeklyRow').hidden = type !== 'weekly';
}
async function saveSchedule() {
  const type = (document.querySelector('input[name="adsSchedType"]:checked') || {}).value || 'once';
  const sel = $('#adsSchedTarget');
  const target = sel.value || 'ALL';
  const targetName = target === 'ALL' ? 'Todas las campañas activas' : (sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : target);
  const time = $('#adsSchedTime').value || '';
  const tm = /^(\d{2}):(\d{2})$/.exec(time);
  const msg = $('#adsSchedMsg');
  if (!tm) { msg.textContent = 'Poné una hora válida.'; msg.hidden = false; return; }
  const payload = { type, target, targetName, hh: Number(tm[1]), mm: Number(tm[2]) };
  if (type === 'once') payload.dateStr = $('#adsSchedDate').value || '';
  else payload.dow = Number($('#adsSchedDow').value);
  try {
    const res = await window.api.adsAddSchedule(payload);
    if (res && res.ok) {
      closeSchedEditor();
      if (res.overview) await renderAdsOverview(res.overview); else await renderAdsOverview();
    } else {
      msg.textContent = (res && res.error) || 'No se pudo programar.'; msg.hidden = false;
    }
  } catch (_) { msg.textContent = 'No se pudo programar.'; msg.hidden = false; }
}
async function deleteSchedule(id) {
  try {
    const res = await window.api.adsDeleteSchedule({ id });
    if (res && res.ok && res.overview) await renderAdsOverview(res.overview);
    else await renderAdsOverview();
  } catch (_) {}
}
async function onAdsSchedListClick(e) {
  const del = e.target.closest('[data-ads-sched-del]');
  if (!del) return;
  const id = del.dataset.adsSchedDel;
  const ok = await adsConfirm({ title: 'Eliminar pausa programada', message: '¿Querés eliminar esta pausa programada?', okLabel: 'Sí, eliminar', danger: true });
  if (ok) deleteSchedule(id);
}

async function renderAdsOverviewForced() {
  const btn = $('#adsRefreshBtn');
  const prev = btn.textContent;
  adsConsultasCache = null; // al actualizar a mano, refrescar también las consultas del Contador
  btn.disabled = true; btn.textContent = '⏳ Actualizando…';
  try {
    const ov = await window.api.adsRefresh();
    await renderAdsOverview(ov);
  } catch (_) {
    await renderAdsOverview();
  } finally {
    btn.disabled = false; btn.textContent = prev;
  }
}

async function adsListAccounts() {
  const token = $('#adsToken').value.trim();
  const msg = $('#adsSetupMsg'); msg.hidden = true;
  if (!token) { msg.textContent = 'Pegá el token primero.'; msg.hidden = false; return; }
  const btn = $('#adsListBtn'); btn.disabled = true; btn.textContent = 'Buscando…';
  try {
    const res = await window.api.adsListAccounts(token);
    if (!res.ok) { msg.textContent = res.error; msg.hidden = false; return; }
    const sel = $('#adsAccountSelect');
    sel.innerHTML = '';
    for (const a of res.accounts) {
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = `${a.name} — ${a.id}${a.currency ? ' · ' + a.currency : ''}${a.active ? '' : ' (inactiva)'}`;
      o.dataset.name = a.name || '';
      o.dataset.currency = a.currency || '';
      o.dataset.timezone = a.timezone || '';
      sel.appendChild(o);
    }
    $('#adsAccounts').hidden = false;
  } catch (e) {
    msg.textContent = 'No se pudo consultar: ' + ((e && e.message) || e); msg.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = 'Buscar mis cuentas';
  }
}

async function adsConnect() {
  const token = $('#adsToken').value.trim();
  const sel = $('#adsAccountSelect');
  const opt = sel.options[sel.selectedIndex];
  const msg = $('#adsSetupMsg'); msg.hidden = true;
  if (!opt) { msg.textContent = 'Elegí una cuenta.'; msg.hidden = false; return; }
  const btn = $('#adsConnectBtn'); btn.disabled = true; btn.textContent = 'Conectando…';
  try {
    const res = await window.api.adsConnect({
      token,
      adAccountId: opt.value,
      adAccountName: opt.dataset.name,
      currency: opt.dataset.currency,
      timezone: opt.dataset.timezone,
    });
    if (!res.ok) { msg.textContent = res.error; msg.hidden = false; return; }
    $('#adsToken').value = '';
    $('#adsAccounts').hidden = true;
    await renderAdsOverview();
  } catch (e) {
    msg.textContent = 'No se pudo conectar: ' + ((e && e.message) || e); msg.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = 'Conectar';
  }
}

async function adsDisconnect() {
  try { await window.api.adsDisconnect(); } catch (_) {}
  setAdsView('setup');
}

// --------------------------------------------------------------------------
// Arranque
// --------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  wire();
  initCalendar();
  load();
  loadAppInfo();
  loadStatus();
});
