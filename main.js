/*
 * main.js — Proceso principal de Electron
 * Calendario interactivo WoodTools: ventana del calendario, bandeja del sistema,
 * planificador de recordatorios y notificaciones por nivel de importancia.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const Recurrence = require('./recurrence');
const credentials = require('./credentials');
const meta = require('./integrations/meta');
const hosting = require('./integrations/hosting');
const youtube = require('./integrations/youtube');
const threads = require('./integrations/threads');
const tiktok = require('./integrations/tiktok');

const APP_ID = 'com.woodtools.calendario';
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

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
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    title: 'Calendario WoodTools',
    icon: ICON_PATH,
    backgroundColor: '#14161c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

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
  const menu = Menu.buildFromTemplate([
    { label: 'Abrir calendario', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Salir', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => showMainWindow());
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
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: '🟢 Importante — ' + task.title,
    body: buildBody(task, occInstance),
    icon: ICON_PATH,
    silent: false,
    urgency: 'normal',
  });
  n.on('click', () => showMainWindow());
  n.show();
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

function checkDue() {
  const data = store.read();
  const now = new Date();
  let changed = false;

  for (const task of data.tasks) {
    const isAutoContent = task.type === 'content' && task.publishMode === 'auto';

    // Prescindible (que no sea publicación automática) no genera ningún aviso
    if (!isAutoContent && task.importance === 'PRESCINDIBLE') continue;

    const occ = Recurrence.occurrenceOn(task, now);
    if (!occ) continue;

    const instance = {
      occKey: Recurrence.dayKey(occ),
      start: occ,
      end: new Date(occ.getTime() + Recurrence.durationMs(task)),
    };

    // ¿Ya se disparó esta ocurrencia?
    task.firedKeys = task.firedKeys || [];
    if (task.firedKeys.includes(instance.occKey)) continue;

    // ¿Esta ocurrencia ya está marcada como hecha?
    if (Recurrence.isOccurrenceDone(task, instance.occKey)) continue;

    const diff = now - occ;
    if (diff >= 0 && diff < MISSED_WINDOW_MS) {
      task.firedKeys.push(instance.occKey);
      if (task.firedKeys.length > 60) task.firedKeys = task.firedKeys.slice(-60);
      changed = true;

      if (isAutoContent) {
        attemptPublish(task, instance); // async, no bloquea el bucle
      } else {
        notifyTask(task, instance);
      }
    }
  }

  if (changed) {
    store.write(data);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('data:changed');
    }
  }
}

// ----------------------------------------------------------------------------
// IPC — datos
// ----------------------------------------------------------------------------
ipcMain.handle('data:get', () => store.read());

ipcMain.handle('data:save', (_e, data) => {
  const ok = store.write(data);
  return ok;
});

ipcMain.handle('task:save', (_e, task) => {
  const data = store.read();
  const idx = data.tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) data.tasks[idx] = task;
  else data.tasks.push(task);
  store.write(data);
  broadcastChanged();
  return task;
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

// IPC — Conexiones (credenciales de APIs)
ipcMain.handle('connections:summary', () => credentials.summary());
ipcMain.handle('connections:getMeta', () => credentials.getPlatform('meta') || {});
ipcMain.handle('connections:saveMeta', async (_e, data) => {
  credentials.setPlatform('meta', data);
  // Best-effort: convertir el token a uno de Página permanente (no vence)
  try {
    if (data.appId && data.appSecret && data.pageToken && data.pageId) {
      const r = await meta.makePermanent(data);
      if (r.changed) {
        credentials.setPlatform('meta', { ...data, pageToken: r.pageToken });
        return { ok: true, upgraded: true };
      }
    }
  } catch (_) { /* si no se pudo, queda el token tal cual */ }
  return { ok: true, upgraded: false };
});
ipcMain.handle('connections:testMeta', (_e, creds) => meta.testConnection(creds));

// Renueva el token de Facebook a larga duración (60 días, no vence) y lo guarda
ipcMain.handle('connections:upgradeMetaToken', async (_e, creds) => {
  try {
    const r = await meta.exchangeForLongLived(creds);
    const merged = { ...creds, pageToken: r.pageToken };
    credentials.setPlatform('meta', merged);
    return { ok: true, pageName: r.pageName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('connections:getHosting', () => credentials.getPlatform('hosting') || {});
ipcMain.handle('connections:saveHosting', (_e, data) => credentials.setPlatform('hosting', data));

// IPC — YouTube
ipcMain.handle('connections:getYoutube', () => {
  const y = credentials.getPlatform('youtube') || {};
  return { clientId: y.clientId || '', clientSecret: y.clientSecret || '', channel: y.channel || '', connected: !!y.refreshToken };
});
ipcMain.handle('connections:saveYoutube', (_e, data) => {
  const cur = credentials.getPlatform('youtube') || {};
  credentials.setPlatform('youtube', { ...cur, ...data });
  return true;
});
ipcMain.handle('connections:connectYoutube', async (_e, data) => {
  try {
    const cur = credentials.getPlatform('youtube') || {};
    const creds = { ...cur, clientId: data.clientId, clientSecret: data.clientSecret };
    const r = await youtube.connect(creds);
    credentials.setPlatform('youtube', { ...creds, refreshToken: r.refreshToken, channel: r.channel });
    return { ok: true, channel: r.channel };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('connections:testYoutube', async () => {
  const creds = credentials.getPlatform('youtube');
  if (!creds || !creds.refreshToken) return { ok: false, error: 'YouTube no está conectado.' };
  return youtube.testConnection(creds);
});

// IPC — Threads
ipcMain.handle('connections:getThreads', () => {
  const t = credentials.getPlatform('threads') || {};
  return { appId: t.appId || '', appSecret: t.appSecret || '', token: t.token || '', userId: t.userId || '', connected: !!t.token };
});
ipcMain.handle('connections:saveThreads', (_e, data) => {
  const cur = credentials.getPlatform('threads') || {};
  credentials.setPlatform('threads', { ...cur, ...data });
  return true;
});
ipcMain.handle('connections:testThreads', async (_e, creds) => threads.testConnection(creds || credentials.getPlatform('threads')));

// IPC — TikTok
ipcMain.handle('connections:getTiktok', () => {
  const t = credentials.getPlatform('tiktok') || {};
  return { clientKey: t.clientKey || '', clientSecret: t.clientSecret || '', directPost: !!t.directPost, connected: !!t.accessToken };
});
ipcMain.handle('connections:saveTiktok', (_e, data) => {
  const cur = credentials.getPlatform('tiktok') || {};
  credentials.setPlatform('tiktok', { ...cur, ...data });
  return true;
});
ipcMain.handle('connections:connectTiktok', async (_e, data) => {
  try {
    const cur = credentials.getPlatform('tiktok') || {};
    const creds = { ...cur, clientKey: data.clientKey, clientSecret: data.clientSecret };
    const r = await tiktok.connect(creds);
    credentials.setPlatform('tiktok', { ...creds, accessToken: r.accessToken, refreshToken: r.refreshToken, openId: r.openId });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('connections:testTiktok', async () => {
  const creds = credentials.getPlatform('tiktok');
  if (!creds || !creds.accessToken) return { ok: false, error: 'TikTok no está conectado.' };
  return tiktok.testConnection(creds);
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

// IPC — publicar una tarea de contenido ahora mismo (botón manual)
ipcMain.handle('content:publishNow', async (_e, task) => {
  try {
    const results = await dispatchPublish(task);
    const ok = !results.some((r) => r.error);
    if (ok) {
      const data = store.read();
      const t = data.tasks.find((x) => x.id === task.id);
      if (t) {
        markOccurrenceDone(t, Recurrence.dayKey(new Date(t.start)));
        t.publishLog = (t.publishLog || []).concat(
          results.map((r) => ({ platform: r.platform, id: r.id, at: new Date().toISOString() }))
        );
        store.write(data);
        broadcastChanged();
      }
    }
    return results;
  } catch (e) {
    return [{ error: e.message }];
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
      // Disparo diferido simple
      setTimeout(() => {
        const d2 = store.read();
        const t2 = d2.tasks.find((t) => t.id === taskId);
        if (t2 && !Recurrence.isOccurrenceDone(t2, occKey)) {
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
// Publicación automática de contenido
// ----------------------------------------------------------------------------
// Si la tarea tiene un archivo local, lo sube a una URL pública (Instagram la exige)
async function resolveMediaUrl(task) {
  const hostCreds = credentials.getPlatform('hosting');
  if (task.mediaPath && !task.mediaUrl) {
    task.mediaUrl = await hosting.uploadPublic(task.mediaPath, hostCreds);
  }
  // Miniatura/portada a URL pública (para portada de Reel de IG y video de FB)
  if (task.thumbPath && !task.thumbUrl) {
    task.thumbUrl = await hosting.uploadPublic(task.thumbPath, hostCreds);
  }
  return task;
}

// Rutea cada red social a su módulo (Meta / YouTube / TikTok)
async function dispatchPublish(task) {
  const platforms = task.platforms || [];
  const results = [];

  // Instagram / Facebook / Threads necesitan una URL pública → subimos el archivo una vez
  if (platforms.some((p) => ['Instagram', 'Facebook', 'Threads'].includes(p))) {
    await resolveMediaUrl(task);
  }

  const metaPlats = platforms.filter((p) => ['Instagram', 'Facebook'].includes(p));
  if (metaPlats.length) {
    const metaCreds = credentials.getPlatform('meta');
    if (!metaCreds) results.push({ platform: metaPlats.join('/'), error: 'No hay conexión de Meta configurada.' });
    else results.push(...await meta.publishForTask(metaCreds, { ...task, platforms: metaPlats }));
  }

  if (platforms.includes('Threads')) {
    results.push(await threads.publishForTask(credentials.getPlatform('threads'), task));
  }
  if (platforms.includes('YouTube')) {
    results.push(await youtube.publishForTask(credentials.getPlatform('youtube'), task));
  }
  if (platforms.includes('TikTok')) {
    results.push(await tiktok.publishForTask(credentials.getPlatform('tiktok'), task));
  }

  return results;
}

async function attemptPublish(task, instance) {
  try {
    const results = await dispatchPublish(task);
    const errors = results.filter((r) => r.error);
    if (errors.length) {
      notifyPublishError(task, errors.map((e) => e.platform + ': ' + e.error).join(' · '));
    } else {
      const data = store.read();
      const t = data.tasks.find((x) => x.id === task.id);
      if (t) {
        markOccurrenceDone(t, instance.occKey);
        t.publishLog = (t.publishLog || []).concat(
          results.map((r) => ({ platform: r.platform, id: r.id, at: new Date().toISOString() }))
        );
        store.write(data);
        broadcastChanged();
      }
      notifyPublishOk(task, results);
    }
  } catch (e) {
    notifyPublishError(task, e.message);
  }
}

function notifyPublishOk(task, results) {
  if (!Notification.isSupported()) return;
  const plats = results.map((r) => r.platform).join(', ');
  const n = new Notification({
    title: '✅ Publicado — ' + task.title,
    body: 'Se publicó en: ' + plats,
    icon: ICON_PATH,
  });
  n.on('click', () => showMainWindow());
  n.show();
}

function notifyPublishError(task, msg) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: '⚠️ No se pudo publicar — ' + task.title,
    body: msg,
    icon: ICON_PATH,
  });
  n.on('click', () => showMainWindow());
  n.show();
}

// ----------------------------------------------------------------------------
// Ciclo de vida
// ----------------------------------------------------------------------------
app.whenReady().then(() => {
  app.setAppUserModelId(APP_ID);
  createMainWindow();
  createTray();

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
