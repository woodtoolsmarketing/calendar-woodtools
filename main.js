/*
 * main.js — Proceso principal de Electron
 * Calendario interactivo WoodTools: ventana del calendario, bandeja del sistema,
 * planificador de recordatorios, notificaciones por nivel de importancia,
 * conexiones con las redes y publicación automática (con reintentos).
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const store = require('./store');
const Recurrence = require('./recurrence');
const credentials = require('./credentials');
const tokens = require('./tokens');
const meta = require('./integrations/meta');
const hosting = require('./integrations/hosting');
const youtube = require('./integrations/youtube');
const threads = require('./integrations/threads');
const tiktok = require('./integrations/tiktok');

const APP_ID = 'com.woodtools.calendario';
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

const DEFAULT_REDIRECT_URI = 'https://calendario-woodtools.onrender.com/oauth/callback.html';
const FACEBOOK_REDIRECT_URI = 'https://www.facebook.com/connect/login_success.html';
const TIKTOK_REDIRECT_URI = 'http://127.0.0.1:8723/';
const SITE_BASE = 'https://calendario-woodtools.onrender.com';

// Hosts permitidos para abrir en el navegador desde la app
const EXTERNAL_HOSTS = [
  'calendario-woodtools.onrender.com', 'developers.facebook.com', 'business.facebook.com', 'www.facebook.com',
  'developers.tiktok.com', 'www.tiktok.com', 'console.cloud.google.com', 'support.google.com', 'www.youtube.com',
  'myaccount.google.com', 'security.google.com', 'policies.google.com', 'www.google.com', 'cloudinary.com',
  'console.cloudinary.com', 'www.threads.com', 'www.instagram.com',
];

// Si arranca con Windows, lo hace oculto (directo a la bandeja, sin abrir la ventana)
const START_HIDDEN = process.argv.includes('--hidden');

// Activa/desactiva el inicio automático con Windows
function setAutoStart(enabled) {
  try {
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
    } else {
      // En modo desarrollo (electron .) hay que pasar la ruta del proyecto
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args: [path.resolve(__dirname), '--hidden'],
      });
    }
  } catch (e) {
    console.error('[autostart] error:', e.message);
  }
}

function isAutoStartOn() {
  try { return app.getLoginItemSettings().openAtLogin; } catch (_) { return false; }
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
const alertWindows = new Map(); // taskId -> BrowserWindow

// ----------------------------------------------------------------------------
// Instancia única
// ----------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

// ----------------------------------------------------------------------------
// Ventana principal
// ----------------------------------------------------------------------------
const APP_INDEX_PATH = path.join(__dirname, 'src', 'index.html');

// ¿La URL es la propia página de la app (src/index.html)? Ignora #hash y ?query.
function isAppIndexUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'file:') return false;
    const own = pathToFileURL(APP_INDEX_PATH);
    const norm = (s) => {
      const v = decodeURIComponent(s);
      return process.platform === 'win32' ? v.toLowerCase() : v;
    };
    return norm(u.host) === norm(own.host) && norm(u.pathname) === norm(own.pathname);
  } catch (_) {
    return false;
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    title: 'Calendario WoodTools',
    icon: ICON_PATH,
    backgroundColor: '#14161c',
    show: !START_HIDDEN, // si arrancó con Windows, queda en la bandeja sin abrir
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // Seguridad: la ventana no abre ventanas nuevas ni navega fuera de la app.
  // Los links permitidos (https y hosts conocidos) se abren en el navegador del sistema.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) {
      try {
        Promise.resolve(shell.openExternal(new URL(String(url)).toString())).catch(() => {});
      } catch (_) {}
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, legacyUrl) => {
    const url = (event && event.url) || legacyUrl;
    if (!isAppIndexUrl(url)) event.preventDefault();
  });

  mainWindow.loadFile(APP_INDEX_PATH);

  // Cerrar = minimizar a la bandeja (sigue corriendo para los recordatorios)
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function showMainWindow() {
  if (!mainWindow) {
    createMainWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

// Envía un evento a la ventana principal (espera a que cargue si hace falta)
function sendToMain(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (wc.isLoading()) wc.once('did-finish-load', () => { if (!wc.isDestroyed()) wc.send(channel, payload); });
  else wc.send(channel, payload);
}

// Abre la ventana y el panel "⚙ Conexiones"
function openConnectionsUI() {
  showMainWindow();
  sendToMain('ui:openConnections');
}

// ----------------------------------------------------------------------------
// Bandeja del sistema
// ----------------------------------------------------------------------------
function createTray() {
  let icon = nativeImage.createFromPath(ICON_PATH);
  if (icon.isEmpty()) {
    // Respaldo mínimo para que la bandeja no quede invisible
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip('Calendario WoodTools');
  refreshTrayMenu();
  tray.on('double-click', () => showMainWindow());
}

function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Abrir calendario', click: () => showMainWindow() },
    { label: 'Estado de conexiones', click: () => openConnectionsUI() },
    { type: 'separator' },
    {
      label: 'Iniciar con Windows',
      type: 'checkbox',
      checked: isAutoStartOn(),
      click: (item) => { setAutoStart(item.checked); refreshTrayMenu(); },
    },
    { type: 'separator' },
    { label: 'Salir', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ----------------------------------------------------------------------------
// Notificaciones de Windows
// ----------------------------------------------------------------------------
// Se guardan referencias para que el recolector no las borre (si no, el clic no llega)
const liveNotifications = new Set();

function showNotification({ title, body, onClick, urgency = 'normal' }) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: ICON_PATH, silent: false, urgency });
    const release = () => liveNotifications.delete(n);
    n.on('click', () => { release(); try { (onClick || showMainWindow)(); } catch (_) {} });
    n.on('close', release);
    n.on('failed', release);
    liveNotifications.add(n);
    if (liveNotifications.size > 50) liveNotifications.delete(liveNotifications.values().next().value);
    n.show();
  } catch (e) {
    console.error('[notify] error:', e.message);
  }
}

// ----------------------------------------------------------------------------
// Notificaciones por importancia
// ----------------------------------------------------------------------------
function notifyTask(task, occInstance) {
  const importance = task.importance || 'PRESCINDIBLE';
  if (importance === 'TRASCENDENTAL') {
    showTrascendentalAlert(task, occInstance);
  } else if (importance === 'IMPORTANTE') {
    showWindowsNotification(task, occInstance);
  }
  // PRESCINDIBLE: no notifica, sólo aparece dentro del programa.
}

function showWindowsNotification(task, occInstance) {
  showNotification({
    title: '🟢 Importante — ' + task.title,
    body: buildBody(task, occInstance),
  });
}

function showTrascendentalAlert(task, occInstance) {
  // Si ya hay una alerta abierta para esta tarea/ocurrencia, no duplicar
  const key = task.id + ':' + (occInstance ? occInstance.occKey : '');
  if (alertWindows.has(key)) {
    const w = alertWindows.get(key);
    if (!w.isDestroyed()) { w.show(); w.focus(); return; }
  }

  const win = new BrowserWindow({
    width: 480,
    height: 400,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    center: true,
    show: false,
    backgroundColor: '#1a0e14',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Nivel máximo para saltar por encima de todo y "pausar" la atención
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);
  win.loadFile(path.join(__dirname, 'alert.html'));

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('alert:data', {
      task,
      occKey: occInstance ? occInstance.occKey : null,
      whenText: buildWhenText(occInstance),
    });
    win.show();
    win.focus();
    win.moveTop();
    win.flashFrame(true);
  });

  win.on('closed', () => alertWindows.delete(key));
  alertWindows.set(key, win);
}

function buildWhenText(occInstance) {
  const d = occInstance ? new Date(occInstance.start) : new Date();
  return d.toLocaleString('es-AR', {
    weekday: 'long', day: '2-digit', month: 'long',
    hour: '2-digit', minute: '2-digit',
  });
}

function buildBody(task, occInstance) {
  const parts = [];
  if (task.type === 'content') {
    const plats = (task.platforms || []).join(', ');
    parts.push(`📲 ${task.contentType || 'Contenido'}${plats ? ' · ' + plats : ''}`);
  }
  parts.push(buildWhenText(occInstance));
  if (task.notes) parts.push(task.notes);
  return parts.join('\n');
}

// ----------------------------------------------------------------------------
// Planificador: revisa tareas vencidas cada 30 segundos
// ----------------------------------------------------------------------------
const MISSED_WINDOW_MS = 12 * 60 * 60 * 1000; // recupera recordatorios perdidos del día
const MISSED_NOTICE_MAX_MS = 7 * 24 * 60 * 60 * 1000; // avisa publicaciones perdidas hasta 7 días atrás
const MAX_KEYS = 60; // tope de claves guardadas por tarea (firedKeys, missedNotified, etc.)

// 'YYYY-MM-DD' → Date al mediodía local de ese día
function keyToDate(occKey) {
  const [y, m, d] = String(occKey).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0, 0);
}

// Ocurrencias ya empezadas de hoy y de los últimos `daysBack` días (más reciente primero)
function recentOccurrences(task, now, daysBack) {
  const out = [];
  for (let i = 0; i <= daysBack; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12, 0, 0, 0);
    const occ = Recurrence.occurrenceOn(task, day);
    if (occ && occ <= now) out.push(occ);
  }
  return out;
}

function pushCapped(arr, value) {
  const list = Array.isArray(arr) ? arr : [];
  if (!list.includes(value)) list.push(value);
  return list.length > MAX_KEYS ? list.slice(-MAX_KEYS) : list;
}

function checkDue() {
  const data = store.read();
  const now = new Date();
  let changed = false;

  for (const task of data.tasks) {
    try {
      if (processTaskDue(task, now)) changed = true;
    } catch (e) {
      console.error('[planificador] error con la tarea', task && task.id, '-', e.message);
    }
  }

  if (changed) {
    store.write(data);
    broadcastChanged();
  }
}

// Devuelve true si modificó la tarea
function processTaskDue(task, now) {
  if (!task || !task.start) return false;
  const isAutoContent = task.type === 'content' && task.publishMode === 'auto';

  // Prescindible (que no sea publicación automática) no genera ningún aviso
  if (!isAutoContent && task.importance === 'PRESCINDIBLE') return false;

  // Pospuesta: esperar a que termine la posposición
  if (task.snoozeUntil && now < new Date(task.snoozeUntil)) return false;

  let changed = false;

  // 1) Reintentos pendientes de publicaciones automáticas (aunque firedKeys ya tenga la ocurrencia)
  if (isAutoContent && task.retryState && typeof task.retryState === 'object') {
    for (const occKey of Object.keys(task.retryState)) {
      const rs = task.retryState[occKey];
      const stillExists = !!Recurrence.occurrenceOn(task, keyToDate(occKey));
      if (!rs || !stillExists || Recurrence.isOccurrenceDone(task, occKey)) {
        delete task.retryState[occKey];
        changed = true;
        continue;
      }
      // Reintento "de seguridad" de una publicación que quedó a medias (la app se cerró o se apagó la PC)
      if (rs.running && !isPublishing(task.id, occKey)) {
        if (settleInterruptedPublish(task, occKey, rs)) changed = true;
        if (!task.retryState[occKey]) continue;
      }
      if (!rs.nextAt || now.getTime() < rs.nextAt) continue;
      if (isPublishing(task.id, occKey)) continue;
      runPublish(task, occKey, { mode: 'retry', only: rs.platforms }); // async, no bloquea el bucle
    }
    if (!Object.keys(task.retryState).length) {
      delete task.retryState;
      changed = true;
    }
  }

  // 2) Ocurrencias recientes: disparar (hasta 12 h tarde) o avisar que se perdieron (auto, hasta 7 días)
  task.firedKeys = Array.isArray(task.firedKeys) ? task.firedKeys : [];
  const daysBack = isAutoContent ? 7 : 1;
  for (const occ of recentOccurrences(task, now, daysBack)) {
    const occKey = Recurrence.dayKey(occ);

    // ¿Esta ocurrencia ya está marcada como hecha? ¿Ya se disparó?
    if (Recurrence.isOccurrenceDone(task, occKey)) continue;
    if (task.firedKeys.includes(occKey)) continue;

    const diff = now - occ;
    if (diff >= 0 && diff < MISSED_WINDOW_MS) {
      task.firedKeys = pushCapped(task.firedKeys, occKey);
      changed = true;
      const instance = {
        occKey,
        start: occ,
        end: new Date(occ.getTime() + Recurrence.durationMs(task)),
      };
      if (isAutoContent) {
        attemptPublish(task, instance); // async, no bloquea el bucle
      } else {
        notifyTask(task, instance);
      }
    } else if (isAutoContent && diff < MISSED_NOTICE_MAX_MS) {
      // Publicación automática que no se hizo (la PC estaba apagada): un solo aviso
      if (Array.isArray(task.missedNotified) && task.missedNotified.includes(occKey)) continue;
      if (task.retryState && task.retryState[occKey]) continue;
      if (task.publishState && task.publishState[occKey]) continue;
      if (task.notifiedErrors && task.notifiedErrors[occKey]) continue;
      if (task.publishErrors && task.publishErrors[occKey]) continue; // se intentó publicar (no estaba apagada)
      task.missedNotified = pushCapped(task.missedNotified, occKey);
      changed = true;
      notifyMissed(task, occ);
    }
  }

  return changed;
}

function notifyMissed(task, occ) {
  showNotification({
    title: '⏰ Publicación perdida — ' + task.title,
    body: `No se publicó ${task.title} porque la PC estaba apagada. Abrí la tarea y tocá Publicar ahora.\n` + buildWhenText({ start: occ }),
  });
}

// ----------------------------------------------------------------------------
// IPC — datos
// ----------------------------------------------------------------------------
// Campos que maneja SOLO el proceso principal (el renderer puede tener una copia vieja)
const MAIN_OWNED_FIELDS = ['publishState', 'retryState', 'missedNotified', 'notifiedErrors', 'publishLog', 'publishErrors', 'mediaCache'];

ipcMain.handle('data:get', () => store.read());

ipcMain.handle('data:save', (_e, data) => {
  // Guardado completo: los campos del proceso principal se toman de lo guardado (la copia del renderer puede ser vieja)
  const prevTasks = new Map(store.read().tasks.map((t) => [t && t.id, t]));
  const next = data && typeof data === 'object' ? { ...data } : {};
  if (Array.isArray(next.tasks)) {
    next.tasks = next.tasks.map((task) => {
      if (!task || typeof task !== 'object') return task;
      const prev = prevTasks.get(task.id);
      const merged = { ...task };
      for (const f of MAIN_OWNED_FIELDS) {
        if (prev && prev[f] !== undefined) merged[f] = prev[f];
        else delete merged[f];
      }
      return merged;
    });
  }
  const ok = store.write(next);
  return ok;
});

ipcMain.handle('task:save', (_e, task) => {
  if (!task || !task.id) return task;
  const data = store.read();
  const idx = data.tasks.findIndex((t) => t.id === task.id);
  const next = { ...task };
  const prev = idx >= 0 ? data.tasks[idx] : null;
  for (const f of MAIN_OWNED_FIELDS) {
    if (prev && prev[f] !== undefined) next[f] = prev[f];
    else delete next[f];
  }
  // Publicación automática guardada con fechas ya pasadas (más de 12 h): no avisar
  // "no se publicó porque la PC estaba apagada" por ocurrencias que se acaban de crear
  if (next.type === 'content' && next.publishMode === 'auto' && next.start) {
    try {
      const now = new Date();
      for (const occ of recentOccurrences(next, now, 7)) {
        if (now - occ >= MISSED_WINDOW_MS) next.missedNotified = pushCapped(next.missedNotified, Recurrence.dayKey(occ));
      }
    } catch (_) { /* fecha inválida: el planificador la ignora */ }
  }
  if (idx >= 0) data.tasks[idx] = next;
  else data.tasks.push(next);
  store.write(data);
  broadcastChanged();
  return next;
});

ipcMain.handle('task:delete', (_e, id) => {
  const data = store.read();
  data.tasks = data.tasks.filter((t) => t.id !== id);
  store.write(data);
  broadcastChanged();
  return true;
});

ipcMain.handle('template:save', (_e, tpl) => {
  const data = store.read();
  const idx = data.templates.findIndex((t) => t.id === tpl.id);
  if (idx >= 0) data.templates[idx] = tpl;
  else data.templates.push(tpl);
  store.write(data);
  broadcastChanged();
  return tpl;
});

ipcMain.handle('template:delete', (_e, id) => {
  const data = store.read();
  data.templates = data.templates.filter((t) => t.id !== id);
  store.write(data);
  broadcastChanged();
  return true;
});

ipcMain.handle('notify:test', (_e, task) => {
  notifyTask(task, {
    occKey: Recurrence.dayKey(new Date()),
    start: new Date(),
    end: new Date(Date.now() + 30 * 60000),
  });
  return true;
});

// IPC — elegir archivo local (imagen/video) y guardarlo en la app
ipcMain.handle('media:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Elegí la imagen o el video',
    properties: ['openFile'],
    filters: [
      { name: 'Imágenes y videos', extensions: ['jpg', 'jpeg', 'png', 'mp4', 'mov', 'm4v'] },
      { name: 'Todos', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const src = res.filePaths[0];
  try {
    const mediaDir = path.join(app.getPath('userData'), 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    const ext = path.extname(src) || '';
    const dest = path.join(mediaDir, Date.now().toString(36) + ext);
    fs.copyFileSync(src, dest);
    return { path: dest, name: path.basename(src) };
  } catch (e) {
    return { error: e.message };
  }
});

// IPC — acciones desde la ventana de alerta trascendental
ipcMain.on('alert:action', (_e, payload) => {
  const { action, taskId, occKey } = payload;
  const data = store.read();
  const task = data.tasks.find((t) => t.id === taskId);
  if (task) {
    if (action === 'done') {
      markOccurrenceDone(task, occKey);
      store.write(data);
      broadcastChanged();
    } else if (action === 'snooze') {
      // Posponer 10 min: limpiar la marca de disparo y reprogramar puntual
      task.firedKeys = (task.firedKeys || []).filter((k) => k !== occKey);
      const snoozeAt = new Date(Date.now() + 10 * 60000);
      task.snoozeUntil = snoozeAt.toISOString();
      // Disparo diferido simple (si la app se reinicia, lo retoma checkDue)
      setTimeout(() => {
        const d2 = store.read();
        const t2 = d2.tasks.find((t) => t.id === taskId);
        if (t2 && !Recurrence.isOccurrenceDone(t2, occKey) && !(t2.firedKeys || []).includes(occKey)) {
          t2.firedKeys = pushCapped(t2.firedKeys, occKey);
          store.write(d2);
          notifyTask(t2, { occKey, start: snoozeAt, end: new Date(snoozeAt.getTime() + 30 * 60000) });
        }
      }, 10 * 60000);
      store.write(data);
    }
  }
  // Cerrar la ventana de alerta
  const key = taskId + ':' + (occKey || '');
  const w = alertWindows.get(key);
  if (w && !w.isDestroyed()) w.close();
});

function markOccurrenceDone(task, occKey) {
  if (task.recurrence && task.recurrence.freq && task.recurrence.freq !== 'none') {
    task.doneOccurrences = task.doneOccurrences || [];
    if (!task.doneOccurrences.includes(occKey)) task.doneOccurrences.push(occKey);
  } else {
    task.status = 'done';
  }
}

function broadcastChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('data:changed');
  }
}

// ----------------------------------------------------------------------------
// Conexiones: vistas (SIN secretos ni tokens), guardar, conectar, pegar token, desconectar
// ----------------------------------------------------------------------------
const CONN_PLATFORMS = ['facebook', 'instagram', 'threads', 'youtube', 'tiktok', 'hosting'];
const STORAGE_OF = { facebook: 'meta', instagram: 'meta', threads: 'threads', youtube: 'youtube', tiktok: 'tiktok', hosting: 'hosting' };

// Campos que el renderer puede guardar (todo lo demás se ignora)
const SAVE_FIELDS = {
  facebook: { strings: ['appId', 'appSecret', 'pageId'], bools: ['liveMode'] },
  instagram: { strings: ['igAppId', 'igAppSecret', 'redirectUri'] },
  threads: { strings: ['appId', 'appSecret', 'redirectUri'] },
  youtube: { strings: ['clientId', 'clientSecret'], bools: ['auditApproved'] },
  tiktok: { strings: ['clientKey', 'clientSecret'], bools: ['directPost'] },
  hosting: { strings: ['cloudName', 'uploadPreset'], numbers: ['maxVideoMB', 'maxImageMB'] },
};

// Campos que se borran al desconectar: tokens y datos de la cuenta
// (se conservan los ids y secretos de la app, y el ID de Página que carga el usuario)
const TOKEN_FIELDS = {
  facebook: ['pageToken', 'pageTokenType', 'pageTokenExpiresAt', 'pageName'],
  instagram: ['igToken', 'igTokenIssuedAt', 'igTokenExpiresAt', 'igLastRefreshAt', 'igUserId', 'igUsername'],
  threads: ['token', 'issuedAt', 'expiresAt', 'lastRefreshAt', 'dataAccessExpiresAt', 'userId', 'username'],
  youtube: ['refreshToken', 'lastRefreshAt', 'needsReconnect', 'channel', 'channelId', 'scope', 'connectedAt'],
  tiktok: ['accessToken', 'refreshToken', 'accessExpiresAt', 'refreshExpiresAt', 'needsReconnect', 'openId', 'displayName', 'scope', 'firstConsentAt'],
};

function isConnPlatform(p) {
  return CONN_PLATFORMS.includes(p);
}

function credsOf(storage) {
  try { return credentials.getPlatform(storage) || {}; } catch (_) { return {}; }
}

function str(v) {
  return v === undefined || v === null ? '' : String(v);
}

function numOrNull(v) {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) || n <= 0 ? null : n;
}

function errMsg(e) {
  return (e && e.message) || (e ? String(e) : '') || 'Error desconocido.';
}

function formatDateTime(ms) {
  return new Date(ms).toLocaleString('es-AR', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function statusFor(platform) {
  try { return tokens.getAll()[platform] || null; } catch (_) { return null; }
}

function refreshInBackground() {
  Promise.resolve().then(() => tokens.runAll()).catch((e) => console.error('[tokens] runAll:', errMsg(e)));
}

// VIEW de cada red: nunca incluye secretos ni tokens
function buildView(platform) {
  const status = statusFor(platform);
  const statusCheckedAt = status ? Number(status.checkedAt) || 0 : 0;
  // Un "reconectar" del estado solo cuenta si se revisó DESPUÉS de la última conexión
  const statusNeedsReconnect = (connectedAt) => !!(status && status.needsReconnect) && statusCheckedAt > (Number(connectedAt) || 0);
  switch (platform) {
    case 'facebook': {
      const m = credsOf('meta');
      return {
        appId: str(m.appId), hasAppSecret: !!m.appSecret, pageId: str(m.pageId), pageName: str(m.pageName),
        connected: !!m.pageToken, tokenType: m.pageTokenType || null, expiresAt: numOrNull(m.pageTokenExpiresAt),
        liveMode: !!m.liveMode, status,
      };
    }
    case 'instagram': {
      const m = credsOf('meta');
      return {
        igAppId: str(m.igAppId), hasIgAppSecret: !!m.igAppSecret, igUserId: str(m.igUserId), igUsername: str(m.igUsername),
        connected: !!m.igToken, expiresAt: numOrNull(m.igTokenExpiresAt), redirectUri: m.redirectUri || DEFAULT_REDIRECT_URI, status,
      };
    }
    case 'threads': {
      const t = credsOf('threads');
      return {
        appId: str(t.appId), hasAppSecret: !!t.appSecret, userId: str(t.userId), username: str(t.username),
        connected: !!t.token, expiresAt: numOrNull(t.expiresAt), redirectUri: t.redirectUri || DEFAULT_REDIRECT_URI, status,
      };
    }
    case 'youtube': {
      const y = credsOf('youtube');
      return {
        clientId: str(y.clientId), hasClientSecret: !!y.clientSecret, channel: str(y.channel),
        connected: !!y.refreshToken, needsReconnect: !!y.needsReconnect || (!!y.refreshToken && statusNeedsReconnect(y.connectedAt)),
        auditApproved: !!y.auditApproved, status,
      };
    }
    case 'tiktok': {
      const t = credsOf('tiktok');
      return {
        clientKey: str(t.clientKey), hasClientSecret: !!t.clientSecret, displayName: str(t.displayName),
        connected: !!t.accessToken, directPost: !!t.directPost,
        accessExpiresAt: numOrNull(t.accessExpiresAt), refreshExpiresAt: numOrNull(t.refreshExpiresAt),
        firstConsentAt: numOrNull(t.firstConsentAt),
        needsReconnect: !!t.needsReconnect || (!!t.accessToken && statusNeedsReconnect(t.firstConsentAt)), status,
      };
    }
    case 'hosting': {
      const h = credsOf('hosting');
      return {
        cloudName: str(h.cloudName), uploadPreset: str(h.uploadPreset),
        maxVideoMB: numOrNull(h.maxVideoMB), maxImageMB: numOrNull(h.maxImageMB),
        configured: !!(h.cloudName && h.uploadPreset), status,
      };
    }
    default:
      return null;
  }
}

function toBool(v) {
  return v === true || v === 1 || v === 'true' || v === '1' || v === 'on';
}

function saveConnection(platform, data) {
  if (!isConnPlatform(platform)) return null;
  const spec = SAVE_FIELDS[platform];
  const src = data && typeof data === 'object' ? data : {};
  const storage = STORAGE_OF[platform];
  const patch = {};

  for (const k of spec.strings || []) {
    if (!(k in src) || src[k] === null || src[k] === undefined) continue;
    const v = String(src[k]).trim();
    if (!v) continue; // vacío = conserva lo guardado
    if (k === 'redirectUri' && !/^https:\/\/[^\s]+$/i.test(v)) continue; // Meta exige https
    patch[k] = v;
  }
  for (const k of spec.bools || []) {
    if (!(k in src) || src[k] === null || src[k] === undefined) continue;
    patch[k] = toBool(src[k]); // false también se guarda
  }
  for (const k of spec.numbers || []) {
    if (!(k in src) || src[k] === null || src[k] === undefined || src[k] === '') continue;
    const n = Number(src[k]);
    if (Number.isFinite(n) && n >= 0) patch[k] = n; // 0 = límite del plan gratis
  }

  try {
    // Si cambia la página de Facebook, el token guardado es de la página anterior
    if (platform === 'facebook' && patch.pageId) {
      const prev = credsOf('meta');
      if (prev.pageToken && prev.pageId && String(prev.pageId) !== patch.pageId) {
        credentials.clearFields('meta', ['pageToken', 'pageTokenType', 'pageTokenExpiresAt', 'pageName']);
      }
    }
    if (Object.keys(patch).length) credentials.setPlatform(storage, patch);
  } catch (e) {
    console.error('[conexiones] no se pudo guardar', platform, '-', errMsg(e));
  }
  refreshInBackground();
  return buildView(platform);
}

// Guarda tokens nuevos: los valores vacíos de `clearable` borran el dato viejo
// (ej. un vencimiento anterior cuando el token nuevo no vence)
function storeTokens(storage, values, clearable = []) {
  const set = {};
  const clear = [];
  for (const [k, v] of Object.entries(values)) {
    const empty = v === null || v === undefined || v === '';
    if (!empty) set[k] = v;
    else if (clearable.includes(k)) clear.push(k);
  }
  credentials.setPlatform(storage, set);
  if (clear.length) credentials.clearFields(storage, clear);
}

const CONN_LABELS = { facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads', youtube: 'YouTube', tiktok: 'TikTok' };
const connectingNow = new Set(); // redes con una autorización abierta (evita dos ventanas o dos receptores locales)

async function connectPlatform(platform) {
  if (!isConnPlatform(platform)) return { ok: false, error: 'Red desconocida.' };
  if (platform === 'hosting') {
    return { ok: false, error: 'Cloudinary no se conecta con una cuenta: completá Cloud name y Upload preset y tocá Guardar.', view: buildView('hosting') };
  }
  if (connectingNow.has(platform)) {
    return {
      ok: false,
      error: `Ya hay una autorización de ${CONN_LABELS[platform]} en curso: terminala en la ventana o el navegador que se abrió (o esperá unos minutos y volvé a intentar).`,
      view: buildView(platform),
    };
  }
  connectingNow.add(platform);
  try {
    let account = null;
    if (platform === 'facebook') {
      const r = await meta.connectFacebook(credsOf('meta'));
      storeTokens('meta', {
        pageId: r.pageId, pageName: r.pageName, pageToken: r.pageToken,
        pageTokenType: r.pageTokenType, pageTokenExpiresAt: r.pageTokenExpiresAt,
      }, ['pageName', 'pageTokenType', 'pageTokenExpiresAt']);
      account = r.pageName || r.pageId || null;
    } else if (platform === 'instagram') {
      const r = await meta.connectInstagram(credsOf('meta'));
      storeTokens('meta', {
        igToken: r.igToken, igUserId: r.igUserId, igUsername: r.igUsername, igTokenIssuedAt: r.igTokenIssuedAt,
        igTokenExpiresAt: r.igTokenExpiresAt, igLastRefreshAt: r.igLastRefreshAt,
      }, ['igUsername', 'igTokenExpiresAt', 'igLastRefreshAt']);
      account = r.igUsername || r.igUserId || null;
    } else if (platform === 'threads') {
      const r = await threads.connect(credsOf('threads'));
      storeTokens('threads', {
        token: r.token, userId: r.userId, username: r.username, issuedAt: r.issuedAt, expiresAt: r.expiresAt,
        lastRefreshAt: r.lastRefreshAt, dataAccessExpiresAt: r.dataAccessExpiresAt,
      }, ['username', 'expiresAt', 'lastRefreshAt', 'dataAccessExpiresAt']);
      account = r.username || r.userId || null;
    } else if (platform === 'youtube') {
      const r = await youtube.connect(credsOf('youtube'));
      // lastRefreshAt vacío → la revisión de fondo valida la conexión nueva enseguida
      storeTokens('youtube', {
        refreshToken: r.refreshToken, channel: r.channel, channelId: r.channelId, scope: r.scope,
        connectedAt: r.connectedAt || Date.now(), needsReconnect: false, lastRefreshAt: null,
      }, ['channel', 'channelId', 'scope', 'lastRefreshAt']);
      account = r.channel || null;
    } else if (platform === 'tiktok') {
      const r = await tiktok.connect(credsOf('tiktok'));
      storeTokens('tiktok', {
        accessToken: r.accessToken, refreshToken: r.refreshToken, openId: r.openId, displayName: r.displayName,
        scope: r.scope, accessExpiresAt: r.accessExpiresAt, refreshExpiresAt: r.refreshExpiresAt,
        firstConsentAt: r.firstConsentAt || Date.now(), needsReconnect: false,
      }, ['displayName', 'scope', 'accessExpiresAt', 'refreshExpiresAt']);
      account = r.displayName || null;
    }
    refreshInBackground();
    return { ok: true, account, view: buildView(platform) };
  } catch (e) {
    return { ok: false, error: errMsg(e), view: buildView(platform) };
  } finally {
    connectingNow.delete(platform);
  }
}

async function pasteTokenFor(platform, token) {
  if (!['facebook', 'instagram', 'threads'].includes(platform)) {
    return { ok: false, error: 'Esta red no admite pegar un token. Usá "Conectar".' };
  }
  const clean = typeof token === 'string' ? token.trim().replace(/^Bearer\s+/i, '') : '';
  if (!clean) return { ok: false, error: 'Pegá el token antes de guardar.', view: buildView(platform) };
  if (/\s/.test(clean)) return { ok: false, error: 'El token no puede tener espacios. Copialo de nuevo, completo.', view: buildView(platform) };

  try {
    let account = null;
    let expiresAt = null;
    let r = null;
    const warnings = [];
    if (platform === 'facebook') {
      r = await meta.normalizeFacebookToken(credsOf('meta'), clean);
      storeTokens('meta', {
        pageId: r.pageId, pageName: r.pageName, pageToken: r.pageToken,
        pageTokenType: r.pageTokenType, pageTokenExpiresAt: r.pageTokenExpiresAt,
      }, ['pageName', 'pageTokenType', 'pageTokenExpiresAt']);
      account = r.pageName || r.pageId || null;
      expiresAt = numOrNull(r.pageTokenExpiresAt);
      if (expiresAt) {
        warnings.push(`El token de Facebook vence el ${formatDateTime(expiresAt)}. Para que no venza, usá un token de usuario del sistema o tocá "Conectar".`);
      }
    } else if (platform === 'instagram') {
      r = await meta.normalizeInstagramToken(credsOf('meta'), clean);
      storeTokens('meta', {
        igToken: r.igToken, igUserId: r.igUserId, igUsername: r.igUsername, igTokenIssuedAt: r.igTokenIssuedAt,
        igTokenExpiresAt: r.igTokenExpiresAt, igLastRefreshAt: r.igLastRefreshAt,
      }, ['igUsername', 'igTokenExpiresAt', 'igLastRefreshAt']);
      account = r.igUsername || r.igUserId || null;
      expiresAt = numOrNull(r.igTokenExpiresAt);
    } else {
      r = await threads.normalizeToken(credsOf('threads'), clean);
      storeTokens('threads', {
        token: r.token, userId: r.userId, username: r.username, issuedAt: r.issuedAt, expiresAt: r.expiresAt,
        lastRefreshAt: r.lastRefreshAt, dataAccessExpiresAt: r.dataAccessExpiresAt,
      }, ['username', 'expiresAt', 'lastRefreshAt', 'dataAccessExpiresAt']);
      account = r.username || r.userId || null;
      expiresAt = numOrNull(r.expiresAt);
    }
    if (r && Array.isArray(r.warnings)) {
      for (const w of r.warnings) if (typeof w === 'string' && w && !warnings.includes(w)) warnings.push(w);
    }
    refreshInBackground();
    return { ok: true, account, expiresAt, warnings, view: buildView(platform) };
  } catch (e) {
    return { ok: false, error: errMsg(e), view: buildView(platform) };
  }
}

// Revoca el refresh token viejo de Google (best-effort, no bloquea)
function revokeGoogleToken(token) {
  try {
    fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  } catch (_) {}
}

function disconnectPlatform(platform) {
  if (!isConnPlatform(platform)) return null;
  if (platform !== 'hosting') {
    try {
      if (platform === 'youtube') {
        const old = credsOf('youtube').refreshToken;
        if (old) revokeGoogleToken(old);
      }
      credentials.clearFields(STORAGE_OF[platform], TOKEN_FIELDS[platform]);
    } catch (e) {
      console.error('[conexiones] no se pudo desconectar', platform, '-', errMsg(e));
    }
    refreshInBackground();
  }
  return buildView(platform);
}

ipcMain.handle('conn:get', (_e, platform) => buildView(platform));
ipcMain.handle('conn:save', (_e, platform, data) => saveConnection(platform, data));
ipcMain.handle('conn:connect', (_e, platform) => connectPlatform(platform));
ipcMain.handle('conn:pasteToken', (_e, platform, token) => pasteTokenFor(platform, token));
ipcMain.handle('conn:disconnect', (_e, platform) => disconnectPlatform(platform));

// IPC — estado de las conexiones
ipcMain.handle('status:get', () => tokens.getAll());
ipcMain.handle('status:refresh', () => tokens.runAll());

// IPC — TikTok: info del creador (obligatoria antes de publicar en TikTok)
ipcMain.handle('tiktok:creatorInfo', async () => {
  try {
    await tokens.ensureFresh(['TikTok']);
    const creds = credentials.getPlatform('tiktok');
    if (!creds || !creds.accessToken) return { ok: false, error: 'TikTok no está conectado. Conectalo en ⚙ Conexiones.' };
    const info = await tiktok.queryCreatorInfo(creds);
    return { ok: true, info };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
});

// IPC — abrir un link en el navegador (solo https y hosts conocidos)
function isAllowedExternal(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && !u.username && !u.password && !u.port
      && EXTERNAL_HOSTS.includes(u.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

ipcMain.handle('app:openExternal', async (_e, url) => {
  if (!isAllowedExternal(url)) return false;
  try {
    await shell.openExternal(new URL(String(url)).toString());
    return true;
  } catch (_) {
    return false;
  }
});

ipcMain.handle('app:info', () => ({
  privacyUrl: SITE_BASE + '/privacy.html',
  termsUrl: SITE_BASE + '/terms.html',
  dataDeletionUrl: SITE_BASE + '/data-deletion.html',
  redirectUri: DEFAULT_REDIRECT_URI,
  tiktokRedirectUri: TIKTOK_REDIRECT_URI,
  facebookRedirectUri: FACEBOOK_REDIRECT_URI,
  version: app.getVersion(),
}));

// ----------------------------------------------------------------------------
// Publicación de contenido (automática y manual): por red, sin duplicar y con reintentos
// ----------------------------------------------------------------------------
const PUBLISH_PLATFORMS = ['Facebook', 'Instagram', 'Threads', 'YouTube', 'TikTok'];
const RETRY_DELAYS_MS = [5 * 60000, 15 * 60000, 60 * 60000, 3 * 60 * 60000]; // 5 min, 15 min, 1 h, 3 h
const MAX_RETRIES = RETRY_DELAYS_MS.length;
const MAX_PUBLISH_LOG = 200;
const publishingNow = new Set(); // 'taskId|occKey' en curso

function publishLockKey(taskId, occKey) {
  return taskId + '|' + occKey;
}

function isPublishing(taskId, occKey) {
  return publishingNow.has(publishLockKey(taskId, occKey));
}

// Redes elegidas en la tarea (sin repetir, solo las soportadas)
function targetsOf(task) {
  const out = [];
  for (const p of Array.isArray(task && task.platforms) ? task.platforms : []) {
    if (PUBLISH_PLATFORMS.includes(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

function isStoryTask(task) {
  return String(task.contentType || '').toLowerCase().includes('historia');
}

// Redes pendientes que necesitan una URL pública del archivo
function platformsNeedingUrl(task, pending) {
  const hasLocal = !!task.mediaPath;
  return pending.filter((p) => p === 'Instagram' || p === 'Threads' || (p === 'Facebook' && isStoryTask(task) && !hasLocal));
}

// ¿El error de subida es de configuración/formato/tamaño? (no vale la pena reintentar)
function isUploadConfigError(msg) {
  const text = String(msg || '');
  if (/HTTP 5\d\d/i.test(text)) return false; // Cloudinary caído (respondió una página de error): vale reintentar
  if (/rate limit|too many requests|HTTP 429/i.test(text)) return false; // límite momentáneo de pedidos: pasa solo
  // Configuración, formato, tamaño, o cuenta/plan de Cloudinary (cuota, créditos, cuenta desactivada): reintentar no sirve
  return /falta configurar|no aceptan|no soportado|formato|pesa .*MB|too large|no encuentro el archivo|cloud name|preset|cloud_name|api_key|api key|not allowed|unknown|quota|credits|limit exceeded|\bplan\b|disabled/i.test(text);
}

// Subidas a Cloudinary reutilizables (task.mediaCache, lo maneja solo el proceso principal):
// si el archivo local no cambió (misma ruta, tamaño y fecha de modificación) y la subida tiene menos de 30 días,
// se usa la misma URL en vez de volver a subirlo en cada reintento o "Publicar ahora".
const MEDIA_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function mediaCacheAt(entry) {
  const at = entry && entry.at;
  const n = typeof at === 'number' ? at : Date.parse(at);
  return Number.isFinite(n) ? n : 0;
}

function fileSignature(filePath) {
  try {
    const s = fs.statSync(filePath);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch (_) {
    return null;
  }
}

function readMediaCache(taskId, slot) {
  if (!taskId) return null;
  try {
    const t = store.read().tasks.find((x) => x && x.id === taskId);
    const c = t && t.mediaCache && typeof t.mediaCache === 'object' ? t.mediaCache[slot] : null;
    return c && typeof c === 'object' ? c : null;
  } catch (_) {
    return null;
  }
}

// Guarda la subida en la tarea guardada (releyendo el store)
function saveMediaCache(taskId, slot, entry) {
  if (!taskId) return;
  try {
    const data = store.read();
    const t = data.tasks.find((x) => x && x.id === taskId);
    if (!t) return;
    const cur = t.mediaCache && typeof t.mediaCache === 'object' && !Array.isArray(t.mediaCache) ? t.mediaCache : {};
    t.mediaCache = { ...cur, [slot]: entry };
    store.write(data);
  } catch (e) {
    console.error('[publicar] no se pudo guardar la subida reutilizable:', errMsg(e));
  }
}

// Saca de task.mediaCache lo que ya no sirve (otro archivo elegido o más de 30 días)
function pruneMediaCache(t) {
  if (!t.mediaCache || typeof t.mediaCache !== 'object' || Array.isArray(t.mediaCache)) {
    delete t.mediaCache;
    return;
  }
  const now = Date.now();
  const pathOf = { media: t.mediaPath, thumb: t.thumbPath };
  for (const slot of Object.keys(t.mediaCache)) {
    const e = t.mediaCache[slot];
    const age = now - mediaCacheAt(e);
    const keep = e && typeof e === 'object' && pathOf[slot] && e.path === pathOf[slot] && age >= 0 && age < MEDIA_CACHE_MAX_AGE_MS;
    if (!keep) delete t.mediaCache[slot];
  }
  if (!Object.keys(t.mediaCache).length) delete t.mediaCache;
}

// slot: 'media' | 'thumb'. Lanza si falla la subida (igual que hosting.uploadPublic).
async function uploadWithCache(taskId, slot, filePath) {
  const hostingCreds = credentials.getPlatform('hosting');
  const sig = fileSignature(filePath);
  if (sig) {
    const c = readMediaCache(taskId, slot);
    const info = c && c.info && typeof c.info === 'object' ? c.info : null;
    const age = Date.now() - mediaCacheAt(c);
    const sameCloud = !!info && (!info.cloudName || info.cloudName === (hostingCreds && hostingCreds.cloudName));
    if (info && info.url && sameCloud && c.path === filePath && Number(c.size) === sig.size
      && Number(c.mtimeMs) === sig.mtimeMs && age >= 0 && age < MEDIA_CACHE_MAX_AGE_MS) {
      return info;
    }
  }
  const info = await hosting.uploadPublic(filePath, hostingCreds);
  if (sig && info && info.url) {
    saveMediaCache(taskId, slot, { path: filePath, size: sig.size, mtimeMs: sig.mtimeMs, at: new Date().toISOString(), info });
  }
  return info;
}

/*
 * Archivo → URL pública. Trabaja sobre la COPIA de la tarea (estos campos no se guardan).
 * El archivo local manda sobre una URL guardada; la URL guardada solo se usa si no hay archivo.
 * Lanza si falla la subida.
 */
async function resolveMedia(task, needUrl) {
  delete task.mediaKind;
  delete task.mediaInfo;
  if (task.mediaPath) {
    delete task.mediaUrl;
    if (needUrl.length) {
      const info = await uploadWithCache(task.id, 'media', task.mediaPath);
      task.mediaUrl = info.url;
      task.mediaKind = info.kind;
      task.mediaInfo = info;
    }
  } else if (task.mediaUrl) {
    task.mediaKind = hosting.mediaKind(String(task.mediaUrl).split(/[?#]/)[0]) || null;
  }
}

// Portada (JPEG público) solo para Instagram. Si falla, es un aviso, no un error.
async function resolveThumb(task, pending) {
  delete task.thumbUrl;
  if (!task.thumbPath || !pending.includes('Instagram')) return [];
  const kind = task.mediaKind || (task.mediaPath ? hosting.mediaKind(task.mediaPath) : null);
  if (kind === 'image') return []; // una foto no lleva portada
  try {
    const info = await uploadWithCache(task.id, 'thumb', task.thumbPath);
    task.thumbUrl = info.url;
    return [];
  } catch (e) {
    return ['No se pudo subir la portada a Cloudinary (' + errMsg(e) + '). Instagram va a usar la portada automática.'];
  }
}

// Llama a un publicador y normaliza su respuesta a un Result por red (nunca lanza)
async function callPublisher(names, fn) {
  let raw;
  try {
    raw = await fn();
  } catch (e) {
    return names.map((p) => ({ platform: p, error: `${p}: error inesperado al publicar (${errMsg(e)}).` }));
  }
  const arr = (Array.isArray(raw) ? raw : [raw]).filter((r) => r && typeof r === 'object');
  return names.map((p) => {
    let r = arr.find((x) => x.platform === p);
    if (!r && names.length === 1 && arr.length === 1 && !arr[0].platform) r = arr[0];
    return r ? { ...r, platform: p } : { platform: p, error: `${p}: el publicador no devolvió ningún resultado.` };
  });
}

// Rutea cada red a su módulo. skip = redes que no hay que tocar (ya publicadas, etc.)
// onStart(names): se llama justo antes de cada publicador (para anotar qué red está publicando)
// onResults(list): se llama apenas termina cada publicador (para guardar enseguida lo publicado)
async function dispatchPublish(task, { skip = [], onStart = null, onResults = null } = {}) {
  const start = (names) => {
    if (typeof onStart !== 'function') return;
    try { onStart(names); } catch (e) { console.error('[publicar] no se pudo guardar el avance:', errMsg(e)); }
  };
  const report = (list) => {
    if (typeof onResults !== 'function') return;
    try { onResults(list); } catch (e) { console.error('[publicar] no se pudo guardar el avance:', errMsg(e)); }
  };
  const targets = targetsOf(task);
  const pending = targets.filter((p) => !skip.includes(p));
  if (!pending.length) return [];

  // Tokens al día antes de publicar (tolerante a fallas)
  try { await tokens.ensureFresh(pending); } catch (_) {}

  const t = { ...task, platforms: pending };
  const byPlatform = {};

  // 1) Subir el archivo solo si alguna red pendiente necesita URL pública
  const needUrl = platformsNeedingUrl(t, pending);
  try {
    await resolveMedia(t, needUrl);
  } catch (e) {
    const msg = errMsg(e);
    const transient = !isUploadConfigError(msg);
    for (const p of needUrl) byPlatform[p] = { platform: p, error: msg, transient };
  }
  const thumbWarnings = await resolveThumb(t, pending.filter((p) => !byPlatform[p]));

  // 2) Meta (Facebook + Instagram)
  const metaPlats = pending.filter((p) => (p === 'Facebook' || p === 'Instagram') && !byPlatform[p]);
  if (metaPlats.length) {
    start(metaPlats);
    const list = await callPublisher(metaPlats, () => meta.publishForTask(credentials.getPlatform('meta'), { ...t, platforms: metaPlats }));
    for (const r of list) byPlatform[r.platform] = r;
    report(list);
  }

  // 3) Threads, YouTube, TikTok
  const others = [['Threads', threads, 'threads'], ['YouTube', youtube, 'youtube'], ['TikTok', tiktok, 'tiktok']];
  for (const [name, mod, storage] of others) {
    if (!pending.includes(name) || byPlatform[name]) continue;
    start([name]);
    const list = await callPublisher([name], () => mod.publishForTask(credentials.getPlatform(storage), t));
    byPlatform[name] = list[0];
    report(list);
  }

  if (thumbWarnings.length && byPlatform.Instagram) {
    const r = byPlatform.Instagram;
    r.warnings = (Array.isArray(r.warnings) ? r.warnings : []).concat(thumbWarnings);
  }

  return pending.map((p) => byPlatform[p]).filter(Boolean);
}

function pruneKeyed(obj, max = MAX_KEYS) {
  const keys = Object.keys(obj).sort();
  while (keys.length > max) delete obj[keys.shift()];
}

function withPlatform(platform, msg) {
  const text = String(msg || 'Error desconocido.');
  return text.toLowerCase().startsWith(platform.toLowerCase()) ? text : `${platform}: ${text}`;
}

/*
 * Guarda enseguida (releyendo el store) las redes que ya se publicaron, apenas responde cada
 * publicador: si la app se cierra o se apaga la PC a mitad de camino, no se vuelven a subir.
 */
function savePublishedNow(taskId, occKey, list, { clearInFlight = false } = {}) {
  const items = (Array.isArray(list) ? list : []).filter((r) => r && r.platform && !r.skipped);
  if (!items.length && !clearInFlight) return;
  const data = store.read();
  const t = data.tasks.find((x) => x.id === taskId);
  if (!t) return;
  const nowIso = new Date().toISOString();
  const ok = items.filter((r) => !r.error);
  if (ok.length) {
    t.publishState = t.publishState && typeof t.publishState === 'object' ? t.publishState : {};
    const st = { ...(t.publishState[occKey] || {}) };
    for (const r of ok) {
      st[r.platform] = { id: r.id ? String(r.id) : null, url: r.url || null, at: nowIso };
      if (r.draft) st[r.platform].draft = true;
    }
    t.publishState[occKey] = st;
  }
  const errorsChanged = applyPublishErrors(t, occKey, items, nowIso);
  // El publicador ya respondió: esas redes dejan de estar "publicando" (en la misma escritura)
  let inFlightCleared = false;
  const rs = clearInFlight && t.retryState && typeof t.retryState === 'object' ? t.retryState[occKey] : null;
  if (rs && rs.running && 'inFlight' in rs) {
    delete rs.inFlight;
    inFlightCleared = true;
  }
  if (ok.length || errorsChanged || inFlightCleared) store.write(data);
}

/*
 * Errores por ocurrencia y red (los muestra la tarea): task.publishErrors[occKey][platform] =
 * { error, at, transient, needsReconnect, ambiguous }. Se borra el de una red cuando esa red publica.
 * Devuelve true si cambió algo.
 */
function applyPublishErrors(t, occKey, results, atIso) {
  const all = t.publishErrors && typeof t.publishErrors === 'object' && !Array.isArray(t.publishErrors) ? t.publishErrors : {};
  const cur = all[occKey] && typeof all[occKey] === 'object' ? { ...all[occKey] } : {};
  const published = t.publishState && typeof t.publishState === 'object' && t.publishState[occKey] && typeof t.publishState[occKey] === 'object'
    ? t.publishState[occKey] : {};
  let changed = false;
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || !r.platform || r.skipped) continue;
    if (r.error) {
      // Ya quedó publicada en esta ocurrencia (ej. error inesperado después de publicar): no se marca como fallida
      if (published[r.platform]) continue;
      cur[r.platform] = {
        error: String(r.error),
        at: atIso,
        transient: !!r.transient,
        needsReconnect: !!r.needsReconnect,
        ambiguous: !!r.ambiguous,
      };
      changed = true;
    } else if (cur[r.platform]) {
      delete cur[r.platform];
      changed = true;
    }
  }
  if (!changed) return false;
  const next = { ...all };
  if (Object.keys(cur).length) next[occKey] = cur;
  else delete next[occKey];
  pruneKeyed(next);
  if (Object.keys(next).length) t.publishErrors = next;
  else delete t.publishErrors;
  return true;
}

/*
 * Guarda el resultado (releyendo el store): estado por red, log, ocurrencia hecha,
 * reintentos y qué errores hay que avisar.
 */
function recordPublishResults(taskId, occKey, targets, results, mode) {
  const out = { newlyPublished: [], notifyErrors: [], notifyAmbiguous: [], gaveUp: [], allDone: false, retryAt: null };
  const data = store.read();
  const t = data.tasks.find((x) => x.id === taskId);
  if (!t) return out;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Estado por red
  t.publishState = t.publishState && typeof t.publishState === 'object' ? t.publishState : {};
  const st = { ...(t.publishState[occKey] || {}) };
  for (const r of results) {
    if (!r || r.error || r.skipped) continue;
    st[r.platform] = { id: r.id ? String(r.id) : null, url: r.url || null, at: nowIso };
    if (r.draft) st[r.platform].draft = true;
    out.newlyPublished.push(r);
    t.publishLog = (Array.isArray(t.publishLog) ? t.publishLog : []).concat({
      platform: r.platform, id: r.id ? String(r.id) : null, url: r.url || null, occKey, at: nowIso, draft: !!r.draft,
    });
  }
  if (Array.isArray(t.publishLog) && t.publishLog.length > MAX_PUBLISH_LOG) t.publishLog = t.publishLog.slice(-MAX_PUBLISH_LOG);
  if (Object.keys(st).length) t.publishState[occKey] = st;
  pruneKeyed(t.publishState);
  if (!Object.keys(t.publishState).length) delete t.publishState;

  // Errores por red de esta ocurrencia (se borra el de cada red que publicó)
  applyPublishErrors(t, occKey, results, nowIso);

  // ¿Quedó publicada en todas las redes elegidas?
  out.allDone = targets.length > 0 && targets.every((p) => st[p]);
  if (out.allDone) {
    markOccurrenceDone(t, occKey);
    // Ocurrencia completa: lo que quede es de redes que ya no están elegidas
    if (t.publishErrors && t.publishErrors[occKey]) {
      delete t.publishErrors[occKey];
      if (!Object.keys(t.publishErrors).length) delete t.publishErrors;
    }
  }

  // Reintentos (solo publicaciones automáticas)
  const failed = results.filter((r) => r && r.error);
  // Resultado dudoso (ambiguous: se cortó después de enviar la publicación): nunca se reintenta solo
  const isRetryable = (r) => !!r.transient && !r.needsReconnect && !r.ambiguous;
  const retryable = failed.filter(isRetryable);
  const hard = failed.filter((r) => !isRetryable(r));
  const isAuto = t.type === 'content' && t.publishMode === 'auto';
  t.retryState = t.retryState && typeof t.retryState === 'object' ? t.retryState : {};
  const prevRetry = t.retryState[occKey];

  if (!out.allDone && isAuto && retryable.length) {
    const performed = mode === 'retry' && prevRetry ? (Number(prevRetry.attempts) || 0) + 1 : 0;
    if (performed >= MAX_RETRIES) {
      out.gaveUp = retryable;
      delete t.retryState[occKey];
    } else {
      out.retryAt = nowMs + RETRY_DELAYS_MS[performed];
      t.retryState[occKey] = { attempts: performed, nextAt: out.retryAt, platforms: retryable.map((r) => r.platform) };
    }
  } else {
    delete t.retryState[occKey];
  }
  pruneKeyed(t.retryState);
  if (!Object.keys(t.retryState).length) delete t.retryState;

  // Errores a avisar (una vez por ocurrencia + red)
  if (mode !== 'manual') {
    t.notifiedErrors = t.notifiedErrors && typeof t.notifiedErrors === 'object' ? t.notifiedErrors : {};
    const done = Array.isArray(t.notifiedErrors[occKey]) ? t.notifiedErrors[occKey] : [];
    for (const r of hard.concat(out.gaveUp)) {
      if (done.includes(r.platform)) continue;
      done.push(r.platform);
      if (r.ambiguous) out.notifyAmbiguous.push(r);
      else out.notifyErrors.push(r);
    }
    if (done.length) t.notifiedErrors[occKey] = done;
    pruneKeyed(t.notifiedErrors);
    if (!Object.keys(t.notifiedErrors).length) delete t.notifiedErrors;
  }

  // Subidas reutilizables que ya no sirven (otro archivo o más de 30 días)
  pruneMediaCache(t);

  store.write(data);
  broadcastChanged();
  return out;
}

/*
 * Automático: antes de publicar deja un reintento "de seguridad" con las redes pendientes.
 * Si la app se cierra o se apaga la PC a mitad de camino, al volver se reintentan solo las que
 * faltaron (las ya publicadas están en publishState). Al terminar, recordPublishResults lo reemplaza.
 */
function markPublishing(taskId, occKey, platforms) {
  const data = store.read();
  const t = data.tasks.find((x) => x.id === taskId);
  if (!t) return;
  t.retryState = t.retryState && typeof t.retryState === 'object' ? t.retryState : {};
  const prev = t.retryState[occKey];
  t.retryState[occKey] = {
    attempts: prev ? Number(prev.attempts) || 0 : 0,
    nextAt: Date.now() + RETRY_DELAYS_MS[0],
    platforms: platforms.slice(),
    running: true,
  };
  store.write(data);
}

// Quita el reintento de seguridad si quedó puesto (error inesperado antes de guardar el resultado)
function clearPublishingMarker(taskId, occKey) {
  const data = store.read();
  const t = data.tasks.find((x) => x.id === taskId);
  if (!t || !t.retryState || !t.retryState[occKey] || !t.retryState[occKey].running) return;
  delete t.retryState[occKey];
  if (!Object.keys(t.retryState).length) delete t.retryState;
  store.write(data);
}

// Automático: anota en el reintento de seguridad qué redes están publicando justo ahora (vacío = ninguna)
function setInFlight(taskId, occKey, names) {
  const data = store.read();
  const t = data.tasks.find((x) => x && x.id === taskId);
  const rs = t && t.retryState && typeof t.retryState === 'object' ? t.retryState[occKey] : null;
  if (!rs || !rs.running) return;
  const list = (Array.isArray(names) ? names : []).filter((p) => PUBLISH_PLATFORMS.includes(p));
  if (list.length) rs.inFlight = list;
  else if ('inFlight' in rs) delete rs.inFlight;
  else return;
  store.write(data);
}

/*
 * Publicación automática que quedó a medias porque la app se cerró (o se apagó la PC) mientras publicaba.
 * Las redes que estaban publicando en ese momento (rs.inFlight) y las que ya habían respondido "no confirmado"
 * NO se reintentan solas: pudieron quedar publicadas y se duplicarían. Quedan para revisar, con un aviso
 * por ocurrencia + red. Las demás siguen con el reintento de seguridad.
 * Modifica la tarea recibida (la guarda quien llama). Devuelve true si cambió algo.
 */
function settleInterruptedPublish(task, occKey, rs) {
  const published = (task.publishState && task.publishState[occKey]) || {};
  const saved = (task.publishErrors && task.publishErrors[occKey]) || {};
  const platforms = Array.isArray(rs.platforms) ? rs.platforms : [];
  const inFlight = (Array.isArray(rs.inFlight) ? rs.inFlight : []).filter((p) => PUBLISH_PLATFORMS.includes(p) && !published[p]);
  const doubtful = platforms.filter((p) => !published[p] && !inFlight.includes(p) && saved[p] && saved[p].ambiguous);
  if (!inFlight.length && !doubtful.length && !('inFlight' in rs)) return false;

  if (inFlight.length) {
    applyPublishErrors(task, occKey, inFlight.map((p) => ({
      platform: p,
      error: `${p} no confirmó la publicación (la app se cerró mientras publicaba). Puede que se haya publicado: revisalo antes de volver a intentar.`,
      transient: false,
      needsReconnect: false,
      ambiguous: true,
    })), new Date().toISOString());
  }
  const unsure = inFlight.concat(doubtful);
  if (unsure.length) {
    task.notifiedErrors = task.notifiedErrors && typeof task.notifiedErrors === 'object' ? task.notifiedErrors : {};
    const done = Array.isArray(task.notifiedErrors[occKey]) ? task.notifiedErrors[occKey] : [];
    for (const p of unsure) {
      if (done.includes(p)) continue;
      done.push(p);
      notifyPublishAmbiguous(task, { platform: p });
    }
    task.notifiedErrors[occKey] = done;
    pruneKeyed(task.notifiedErrors);
  }
  rs.platforms = platforms.filter((p) => !unsure.includes(p));
  delete rs.inFlight;
  if (!rs.platforms.length) delete task.retryState[occKey];
  return true;
}

/*
 * Publica una ocurrencia. mode: 'auto' (planificador), 'retry' (reintento), 'manual' (botón).
 * only: limitar a estas redes (reintentos). Nunca lanza. Devuelve Result[] (incluye skipped).
 */
async function runPublish(taskInput, occKey, { mode = 'auto', only = null } = {}) {
  const lock = publishLockKey(taskInput.id, occKey);
  if (publishingNow.has(lock)) {
    return targetsOf(taskInput).map((p) => ({ platform: p, error: 'Ya se está publicando esta tarea. Esperá a que termine.' }));
  }
  publishingNow.add(lock);
  let task = taskInput;
  try {
    // Deja terminar el ciclo actual del planificador antes de leer/escribir el store
    await Promise.resolve();

    const stored = store.read().tasks.find((x) => x.id === taskInput.id) || null;
    if (mode !== 'manual') {
      // Automático: usar siempre lo guardado y confirmar que siga siendo publicación automática
      if (!stored || stored.type !== 'content' || stored.publishMode !== 'auto') return [];
      if (Recurrence.isOccurrenceDone(stored, occKey)) return [];
      task = stored;
    } else {
      task = { ...(stored || {}), ...taskInput };
    }

    const targets = targetsOf(task);
    const state = (stored && stored.publishState && stored.publishState[occKey]) || {};
    const already = targets.filter((p) => state[p]);
    let toPublish = targets.filter((p) => !state[p]);
    if (Array.isArray(only) && only.length) toPublish = toPublish.filter((p) => only.includes(p));
    const autoRun = mode !== 'manual';
    if (autoRun) {
      // Resultado dudoso guardado en esta ocurrencia (ambiguous: pudo quedar publicado, ej. tras "Publicar ahora"
      // o al volver a guardar la tarea): lo automático nunca lo vuelve a publicar. Solo con "Publicar ahora", después de revisarlo.
      const savedErrors = (stored && stored.publishErrors && stored.publishErrors[occKey]) || {};
      toPublish = toPublish.filter((p) => !(savedErrors[p] && savedErrors[p].ambiguous));
    }
    const skip = targets.filter((p) => !toPublish.includes(p));

    if (toPublish.length && autoRun) markPublishing(task.id, occKey, toPublish);
    const results = toPublish.length
      ? await dispatchPublish(task, {
        skip,
        // Automático: anota qué red está publicando en este momento (ver settleInterruptedPublish)
        onStart: autoRun ? (names) => setInFlight(task.id, occKey, names) : null,
        onResults: (list) => savePublishedNow(task.id, occKey, list, { clearInFlight: autoRun }),
      })
      : [];
    const rec = recordPublishResults(task.id, occKey, targets, results, mode);

    if (results.some((r) => r.needsReconnect)) refreshInBackground();
    if (mode !== 'manual') {
      if (rec.newlyPublished.length) notifyPublishOk(task, rec.newlyPublished);
      if (rec.notifyErrors.length) notifyPublishErrors(task, rec.notifyErrors, rec.gaveUp);
      for (const r of rec.notifyAmbiguous) notifyPublishAmbiguous(task, r);
    }

    const skipped = already.map((p) => ({ platform: p, skipped: true, id: state[p].id || undefined, url: state[p].url || undefined }));
    return targets
      .map((p) => results.find((r) => r.platform === p) || skipped.find((r) => r.platform === p))
      .filter(Boolean);
  } catch (e) {
    console.error('[publicar] error inesperado:', errMsg(e));
    if (mode !== 'manual') {
      try { clearPublishingMarker(taskInput.id, occKey); } catch (_) {}
    }
    const results = targetsOf(task).map((p) => ({ platform: p, error: `${p}: error inesperado (${errMsg(e)}).` }));
    try { savePublishedNow(taskInput.id, occKey, results); } catch (_) {} // queda el error en la tarea
    if (mode !== 'manual') notifyPublishErrors(task, results, []);
    return results;
  } finally {
    publishingNow.delete(lock);
  }
}

function attemptPublish(task, instance) {
  runPublish(task, instance.occKey, { mode: 'auto' }).catch((e) => console.error('[publicar]', errMsg(e)));
}

function notifyPublishOk(task, results) {
  // Todo lo que salió bien quedó como borrador (ej. TikTok sin auditoría): no decir "Publicado"
  const allDraft = results.length > 0 && results.every((r) => r.draft);
  const plats = results.map((r) => r.platform + (r.draft && !allDraft ? ' (borrador)' : '')).join(', ');
  const lines = [(allDraft ? 'Se envió a borradores de: ' : 'Se publicó en: ') + plats];
  if (results.some((r) => r.draft)) lines.push('Lo que quedó como borrador lo terminás de publicar desde la app de esa red.');
  // El mismo aviso en varias redes (ej. app de Meta en modo Desarrollo) se muestra una sola vez
  const byText = new Map();
  for (const r of results) {
    for (const w of Array.isArray(r.warnings) ? r.warnings : []) {
      if (typeof w !== 'string' || !w) continue;
      if (!byText.has(w)) byText.set(w, []);
      if (!byText.get(w).includes(r.platform)) byText.get(w).push(r.platform);
    }
  }
  const warnings = [...byText.entries()].map(([w, plats]) => (plats.length === 1 ? withPlatform(plats[0], w) : `${plats.join(' y ')}: ${w}`));
  if (warnings.length) lines.push(warnings.join('\n'));
  showNotification({ title: (allDraft ? '📥 Enviado a borradores — ' : '✅ Publicado — ') + task.title, body: lines.join('\n') });
}

// Publicación dudosa: se cortó la conexión después de enviarla y no se pudo confirmar. No se reintenta sola.
function notifyPublishAmbiguous(task, r) {
  showNotification({
    title: '⚠️ Revisá ' + r.platform,
    body: `No se pudo confirmar si se publicó "${task.title}". Revisalo antes de volver a intentar.`,
  });
}

function notifyPublishErrors(task, errors, gaveUp) {
  const lines = errors.map((r) => {
    if (r.needsReconnect) return `Reconectá ${r.platform} en ⚙ Conexiones` + (r.error ? ` (${r.error})` : '');
    const base = withPlatform(r.platform, r.error);
    return (gaveUp || []).includes(r) ? `${base} — se reintentó ${MAX_RETRIES} veces. Abrí la tarea y tocá Publicar ahora.` : base;
  });
  const reconnect = errors.some((r) => r.needsReconnect);
  showNotification({
    title: '⚠️ No se pudo publicar — ' + task.title,
    body: lines.join('\n'),
    onClick: reconnect ? openConnectionsUI : showMainWindow,
  });
}

// IPC — publicar una tarea de contenido ahora mismo (botón manual)
ipcMain.handle('content:publishNow', async (_e, task) => {
  try {
    if (!task || !task.id) return [{ error: 'No se pudo leer la tarea.' }];
    if (!targetsOf(task).length) return [{ error: 'Elegí al menos una red para publicar.' }];
    const start = new Date(task.start);
    const occKey = Recurrence.dayKey(isNaN(start.getTime()) ? new Date() : start);
    return await runPublish(task, occKey, { mode: 'manual' });
  } catch (e) {
    return [{ error: errMsg(e) }];
  }
});

// ----------------------------------------------------------------------------
// Ciclo de vida
// ----------------------------------------------------------------------------
app.whenReady().then(() => {
  app.setAppUserModelId(APP_ID);

  // Activar el inicio con Windows por defecto la primera vez (después se puede apagar desde la bandeja)
  try {
    const marker = path.join(app.getPath('userData'), '.autostart-set');
    if (!fs.existsSync(marker)) {
      setAutoStart(true);
      fs.writeFileSync(marker, '1');
    }
  } catch (_) {}

  createMainWindow();
  createTray();

  // Mantenimiento de conexiones: a los 8 s y cada 6 h
  tokens.init({
    notify: (title, body) => showNotification({ title, body, onClick: openConnectionsUI }),
    onChange: (statusAll) => sendToMain('status:changed', statusAll),
  });

  // Primer chequeo al ratito y luego cada 30s
  setTimeout(checkDue, 4000);
  setInterval(checkDue, 30 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('before-quit', () => { isQuitting = true; });

// No salir al cerrar todas las ventanas: queda en la bandeja para los recordatorios
app.on('window-all-closed', (e) => {
  // En Windows mantenemos el proceso vivo gracias a la bandeja.
});
