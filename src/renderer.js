/* renderer.js — Lógica del calendario WoodTools */

const IMPORTANCE = {
  TRASCENDENTAL: { label: 'Trascendental', color: '#E84A6F' },
  IMPORTANTE: { label: 'Importante', color: '#2EC4B6' },
  PRESCINDIBLE: { label: 'Prescindible', color: '#B87333' },
};

let state = { tasks: [], templates: [] };
let calendar = null;
let editing = null;        // tarea en edición (o null si es nueva)
let editingOccKey = null;  // ocurrencia puntual seleccionada
let selectedMedia = null;  // { path, name } del archivo elegido
let selectedThumb = null;  // { path, name } de la miniatura/portada

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
    selectedMedia = task.mediaPath ? { path: task.mediaPath, name: task.mediaName || 'archivo' } : null;
    selectedThumb = task.thumbPath ? { path: task.thumbPath, name: task.thumbName || 'miniatura' } : null;
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
    selectedMedia = null;
    selectedThumb = null;
    $('#fStoryLink').checked = false;
    $('#fSaveTemplate').checked = false;
  }

  syncContentBlock();
  syncStoryLink();
  syncAutoFields();
  syncWeekDays();
  renderMediaName();
  renderThumbName();
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
}

function readForm() {
  const date = $('#fDate').value;
  const start = $('#fStart').value || '09:00';
  const end = $('#fEnd').value || '';
  const startDate = combine(date, start);
  let endDate = end ? combine(date, end) : new Date(startDate.getTime() + 30 * 60000);
  if (endDate <= startDate) endDate = new Date(startDate.getTime() + 30 * 60000);

  const type = getRadio('ftype');
  const task = editing ? { ...editing } : { id: uid(), firedKeys: [], doneOccurrences: [], status: 'pending' };
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
  } else {
    delete task.platforms;
    delete task.contentType;
    delete task.publishMode;
    delete task.mediaUrl;
    delete task.caption;
    delete task.link;
    delete task.ytTitle;
    delete task.ytDescription;
    delete task.mediaPath;
    delete task.mediaName;
    delete task.thumbPath;
    delete task.thumbName;
  }
  // Reprogramar limpia los disparos previos
  task.firedKeys = [];
  return task;
}

async function saveForm() {
  const task = readForm();
  if (!task.title) { $('#fTitle').focus(); $('#fTitle').style.outline = '2px solid #E84A6F'; return; }
  $('#fTitle').style.outline = '';

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
  const task = { ...editing };
  if (task.recurrence && task.recurrence.freq && task.recurrence.freq !== 'none') {
    task.doneOccurrences = task.doneOccurrences || [];
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
  if (editing.recurrence && editing.recurrence.freq && editing.recurrence.freq !== 'none') {
    const key = editingOccKey;
    editing.doneOccurrences = (editing.doneOccurrences || []).filter((k) => k !== key);
  } else {
    editing.status = 'pending';
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
    tags.push(`<span class="tc-tag">📲 ${task.contentType || ''}</span>`);
    if (plats) tags.push(`<span class="tc-tag">${plats}</span>`);
    if (task.publishMode === 'auto') tags.push('<span class="tc-tag">🤖 Auto</span>');
  }
  if (task.recurrence && task.recurrence.freq) tags.push('<span class="tc-tag">🔁</span>');

  card.innerHTML = `
    <div class="tc-title">${escapeHtml(task.title)}</div>
    <div class="tc-meta"><span>${when}</span></div>
    <div class="tc-meta">${tags.join('')}</div>`;
  card.onclick = () => openForm({ task, occKey: inst.occKey });
  return card;
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

function syncContentBlock() {
  $('#contentBlock').hidden = getRadio('ftype') !== 'content';
}
function syncStoryLink() {
  $('#storyLinkWrap').hidden = !$('#fStoryLink').checked;
}
function syncAutoFields() {
  const auto = getRadio('ftype') === 'content' && getRadio('pubmode') === 'auto';
  $('#autoFields').hidden = !auto;
  $('#btnPublishNow').hidden = !(auto && editing);
  const ytChecked = $$('input[name="plat"]:checked').some((c) => c.value === 'YouTube');
  $('#ytFields').hidden = !(auto && ytChecked);
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
}

function clearMedia() {
  selectedMedia = null;
  renderMediaName();
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

// --------------------------------------------------------------------------
// Publicar ahora (manual)
// --------------------------------------------------------------------------
async function publishNow() {
  if (!editing) return;
  const task = readForm();
  if (!task.title) { $('#fTitle').focus(); return; }
  const btn = $('#btnPublishNow');
  btn.disabled = true;
  btn.textContent = 'Publicando…';
  await window.api.saveTask(task);
  const results = await window.api.publishNow(task);
  btn.disabled = false;
  btn.textContent = '📤 Publicar ahora';
  const failed = results.filter((r) => r.error);
  if (failed.length) {
    alert('No se pudo publicar:\n' + results.map((r) => (r.platform ? r.platform + ': ' : '') + (r.error || 'OK')).join('\n'));
  } else {
    alert('¡Publicado en ' + results.map((r) => r.platform).join(', ') + '!');
    closeForm();
  }
  await load();
}

// --------------------------------------------------------------------------
// Conexiones (Meta)
// --------------------------------------------------------------------------
async function openConnections() {
  const m = await window.api.getMeta();
  $('#mAppId').value = m.appId || '';
  $('#mAppSecret').value = m.appSecret || '';
  $('#mPageId').value = m.pageId || '';
  $('#mPageToken').value = m.pageToken || '';
  $('#mIgUserId').value = m.igUserId || '';
  $('#mIgToken').value = m.igToken || '';
  const h = await window.api.getHosting();
  $('#hCloudName').value = h.cloudName || '';
  $('#hUploadPreset').value = h.uploadPreset || '';
  updateHostingBadge(!!(h.cloudName && h.uploadPreset));
  const yt = await window.api.getYoutube();
  $('#ytClientId').value = yt.clientId || '';
  $('#ytClientSecret').value = yt.clientSecret || '';
  $('#ytResult').className = 'conn-result';
  $('#ytResult').textContent = '';
  updateYtBadge(yt.connected, yt.channel);
  const th = await window.api.getThreads();
  $('#thAppId').value = th.appId || '';
  $('#thAppSecret').value = th.appSecret || '';
  $('#thToken').value = th.token || '';
  $('#thResult').className = 'conn-result';
  $('#thResult').textContent = '';
  updateBadge('#thStatus', th.connected);
  const tt = await window.api.getTiktok();
  $('#ttClientKey').value = tt.clientKey || '';
  $('#ttClientSecret').value = tt.clientSecret || '';
  $('#ttDirectPost').checked = !!tt.directPost;
  $('#ttResult').className = 'conn-result';
  $('#ttResult').textContent = '';
  updateBadge('#ttStatus', tt.connected);
  const box = $('#connResult');
  box.className = 'conn-result';
  box.textContent = '';
  updateMetaBadge(!!m.pageToken);
  $('#connModal').hidden = false;
}

function readMetaForm() {
  return {
    appId: $('#mAppId').value.trim(),
    appSecret: $('#mAppSecret').value.trim(),
    pageId: $('#mPageId').value.trim(),
    pageToken: $('#mPageToken').value.trim(),
    igUserId: $('#mIgUserId').value.trim(),
    igToken: $('#mIgToken').value.trim(),
    label: 'Meta',
  };
}

async function testMeta() {
  const box = $('#connResult');
  box.className = 'conn-result';
  box.textContent = 'Probando…';
  const res = await window.api.testMeta(readMetaForm());
  if (res.ok) {
    box.className = 'conn-result ok';
    let txt = '✅ Conectado. Página: ' + res.pageName + (res.igUsername ? '  ·  IG: @' + res.igUsername : '  ·  (sin IG configurado)');
    txt += '\n\nDIAGNÓSTICO DEL TOKEN:';
    txt += '\n• Tipo: ' + (res.tokenType || '—') + (res.tokenType === 'PAGE' ? ' ✅' : ' ⚠️ (debería ser PAGE)');
    if (res.tokenEntity) txt += '\n• El token pertenece a: ' + res.tokenEntity;
    txt += '\n• Vence: ' + (res.expiresAt || '—');
    txt += '\n• Permisos: ' + ((res.scopes && res.scopes.length) ? res.scopes.join(', ') : '—');
    if (res.scopes && res.scopes.length) {
      const need = ['pages_manage_posts', 'pages_read_engagement', 'instagram_content_publish', 'instagram_business_content_publish'];
      const faltan = need.filter((p) => !res.scopes.includes(p));
      if (faltan.length) txt += '\n• Faltan: ' + faltan.join(', ');
    }
    if (res.debugError) txt += '\n• (No pude leer permisos: ' + res.debugError + ')';
    txt += '\n\nINSTAGRAM (método nuevo):';
    if (res.igLogin) txt += '\n• Token de IG OK → ' + res.igLogin + ' ✅';
    else if (res.igLoginError) txt += '\n• Token de IG con error: ' + res.igLoginError;
    else txt += '\n• Sin token de IG cargado (pegá el token nuevo para publicar en Instagram)';
    box.textContent = txt;
    updateMetaBadge(true);
  } else {
    box.className = 'conn-result err';
    box.textContent = '❌ ' + (res.error || 'No se pudo conectar.');
    updateMetaBadge(false);
  }
}

async function upgradeToken() {
  const box = $('#connResult');
  box.className = 'conn-result';
  box.textContent = 'Renovando el token a 60 días…';
  // Guardamos primero los datos del formulario (token fresco + App Secret correcto)
  await window.api.saveMeta(readMetaForm());
  const res = await window.api.upgradeMetaToken(readMetaForm());
  if (res.ok) {
    const m = await window.api.getMeta();
    $('#mPageToken').value = m.pageToken || '';
    box.className = 'conn-result ok';
    box.textContent = '✅ Token renovado a larga duración (no vence). Página: ' + (res.pageName || '') + '\nProbá "Probar conexión" para confirmar.';
    updateMetaBadge(true);
  } else {
    box.className = 'conn-result err';
    box.textContent = '❌ No se pudo renovar: ' + res.error + '\n\nRevisá que el App Secret esté bien y que el token pegado sea fresco (recién generado).';
  }
}

async function saveMeta() {
  const saveRes = await window.api.saveMeta(readMetaForm());
  if (saveRes && saveRes.upgraded) {
    const m = await window.api.getMeta(); // recargar el token permanente nuevo
    $('#mPageToken').value = m.pageToken || '';
  }
  const hosting = {
    cloudName: $('#hCloudName').value.trim(),
    uploadPreset: $('#hUploadPreset').value.trim(),
  };
  await window.api.saveHosting(hosting);
  updateHostingBadge(!!(hosting.cloudName && hosting.uploadPreset));
  await window.api.saveYoutube({
    clientId: $('#ytClientId').value.trim(),
    clientSecret: $('#ytClientSecret').value.trim(),
  });
  await window.api.saveThreads(readThreadsForm());
  await window.api.saveTiktok({
    clientKey: $('#ttClientKey').value.trim(),
    clientSecret: $('#ttClientSecret').value.trim(),
    directPost: $('#ttDirectPost').checked,
  });
  await testMeta();
}

function updateMetaBadge(ok) {
  const b = $('#metaStatus');
  b.textContent = ok ? 'Conectado' : 'Sin conectar';
  b.className = 'conn-badge' + (ok ? ' ok' : '');
}

function updateHostingBadge(cloudinary) {
  const b = $('#hostingStatus');
  b.textContent = cloudinary ? 'Cloudinary' : 'Gratis';
  b.className = 'conn-badge' + (cloudinary ? ' ok' : '');
}

function updateYtBadge(connected, channel) {
  const b = $('#ytStatus');
  b.textContent = connected ? (channel ? channel : 'Conectado') : 'Sin conectar';
  b.className = 'conn-badge' + (connected ? ' ok' : '');
}

async function connectYoutube() {
  const box = $('#ytResult');
  const clientId = $('#ytClientId').value.trim();
  const clientSecret = $('#ytClientSecret').value.trim();
  if (!clientId || !clientSecret) {
    box.className = 'conn-result err';
    box.textContent = 'Primero pegá el Client ID y el Client Secret de Google.';
    return;
  }
  await window.api.saveYoutube({ clientId, clientSecret });
  box.className = 'conn-result';
  box.textContent = 'Abriendo el login de Google… autorizá en la ventana que apareció.';
  const res = await window.api.connectYoutube({ clientId, clientSecret });
  if (res.ok) {
    box.className = 'conn-result ok';
    box.textContent = '✅ YouTube conectado. Canal: ' + (res.channel || '(tu canal)');
    updateYtBadge(true, res.channel);
  } else {
    box.className = 'conn-result err';
    box.textContent = '❌ ' + res.error;
  }
}

async function testYoutube() {
  const box = $('#ytResult');
  box.className = 'conn-result';
  box.textContent = 'Probando…';
  const res = await window.api.testYoutube();
  if (res.ok) {
    box.className = 'conn-result ok';
    box.textContent = '✅ Conectado al canal: ' + res.channel;
    updateYtBadge(true, res.channel);
  } else {
    box.className = 'conn-result err';
    box.textContent = '❌ ' + res.error;
  }
}

function updateBadge(sel, ok, text) {
  const b = $(sel);
  b.textContent = ok ? (text || 'Conectado') : 'Sin conectar';
  b.className = 'conn-badge' + (ok ? ' ok' : '');
}

function readThreadsForm() {
  return {
    appId: $('#thAppId').value.trim(),
    appSecret: $('#thAppSecret').value.trim(),
    token: $('#thToken').value.trim(),
  };
}

async function testThreads() {
  const box = $('#thResult');
  box.className = 'conn-result';
  box.textContent = 'Probando…';
  await window.api.saveThreads(readThreadsForm());
  const res = await window.api.testThreads(readThreadsForm());
  if (res.ok) {
    box.className = 'conn-result ok';
    box.textContent = '✅ Threads conectado: @' + res.username;
    updateBadge('#thStatus', true);
  } else {
    box.className = 'conn-result err';
    box.textContent = '❌ ' + res.error;
  }
}

async function connectTiktok() {
  const box = $('#ttResult');
  const clientKey = $('#ttClientKey').value.trim();
  const clientSecret = $('#ttClientSecret').value.trim();
  if (!clientKey || !clientSecret) {
    box.className = 'conn-result err';
    box.textContent = 'Primero pegá el Client Key y Client Secret de TikTok.';
    return;
  }
  await window.api.saveTiktok({ clientKey, clientSecret, directPost: $('#ttDirectPost').checked });
  box.className = 'conn-result';
  box.textContent = 'Abriendo el login de TikTok… autorizá en la ventana.';
  const res = await window.api.connectTiktok({ clientKey, clientSecret });
  if (res.ok) {
    box.className = 'conn-result ok';
    box.textContent = '✅ TikTok conectado.';
    updateBadge('#ttStatus', true);
  } else {
    box.className = 'conn-result err';
    box.textContent = '❌ ' + res.error;
  }
}

async function testTiktok() {
  const box = $('#ttResult');
  box.className = 'conn-result';
  box.textContent = 'Probando…';
  const res = await window.api.testTiktok();
  if (res.ok) {
    box.className = 'conn-result ok';
    box.textContent = '✅ TikTok conectado: ' + res.displayName;
    updateBadge('#ttStatus', true);
  } else {
    box.className = 'conn-result err';
    box.textContent = '❌ ' + res.error;
  }
}

// --------------------------------------------------------------------------
// Eventos UI
// --------------------------------------------------------------------------
function wire() {
  $('#btnNew').onclick = () => openForm({ date: new Date() });
  $('#modalClose').onclick = closeForm;
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeForm(); });
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
  $('#fRecur').onchange = syncWeekDays;
  $('#fWeekdaysOnly').onchange = (e) => { if (e.target.checked) applyWeekdaysOnly(); };
  $('#fTemplate').onchange = (e) => { if (e.target.value) applyTemplate(e.target.value); };
  $$('input[name="ftype"]').forEach((r) => (r.onchange = () => { syncContentBlock(); syncAutoFields(); }));
  $$('input[name="pubmode"]').forEach((r) => (r.onchange = syncAutoFields));
  $$('input[name="plat"]').forEach((c) => (c.onchange = syncAutoFields));
  $('#fStoryLink').onchange = syncStoryLink;

  // Conexiones
  $('#btnConnections').onclick = openConnections;
  $('#connClose').onclick = () => ($('#connModal').hidden = true);
  $('#connModal').addEventListener('click', (e) => { if (e.target.id === 'connModal') $('#connModal').hidden = true; });
  $('#btnTestMeta').onclick = testMeta;
  $('#btnUpgradeToken').onclick = upgradeToken;
  $('#btnSaveMeta').onclick = saveMeta;
  $('#btnConnectYoutube').onclick = connectYoutube;
  $('#btnTestYoutube').onclick = testYoutube;
  $('#btnTestThreads').onclick = testThreads;
  $('#btnConnectTiktok').onclick = connectTiktok;
  $('#btnTestTiktok').onclick = testTiktok;

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
    if (!$('#connModal').hidden) $('#connModal').hidden = true;
    else if (!$('#modal').hidden) closeForm();
  });
}

// --------------------------------------------------------------------------
// Arranque
// --------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  wire();
  initCalendar();
  load();
});
