/*
 * preload.js — Puente seguro entre el renderer y el proceso principal.
 * Expone window.api (calendario) y window.alertApi (ventana trascendental).
 * Nunca pasa secretos ni tokens al renderer: las vistas de conexión solo dicen si están cargados.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getData: () => ipcRenderer.invoke('data:get'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  saveTask: (task) => ipcRenderer.invoke('task:save', task),
  deleteTask: (id) => ipcRenderer.invoke('task:delete', id),
  saveTemplate: (tpl) => ipcRenderer.invoke('template:save', tpl),
  deleteTemplate: (id) => ipcRenderer.invoke('template:delete', id),
  testNotify: (task) => ipcRenderer.invoke('notify:test', task),
  onDataChanged: (cb) => ipcRenderer.on('data:changed', () => cb()),
  pickMedia: () => ipcRenderer.invoke('media:pick'),
  publishNow: (task) => ipcRenderer.invoke('content:publishNow', task),

  // Conexiones (platform = 'facebook' | 'instagram' | 'threads' | 'youtube' | 'tiktok' | 'hosting')
  getConnection: (platform) => ipcRenderer.invoke('conn:get', platform),
  saveConnection: (platform, data) => ipcRenderer.invoke('conn:save', platform, data),
  connect: (platform) => ipcRenderer.invoke('conn:connect', platform),
  pasteToken: (platform, token) => ipcRenderer.invoke('conn:pasteToken', platform, token),
  disconnect: (platform) => ipcRenderer.invoke('conn:disconnect', platform),

  // Estado de las conexiones
  getStatus: () => ipcRenderer.invoke('status:get'),
  refreshStatus: () => ipcRenderer.invoke('status:refresh'),
  onStatusChanged: (cb) => ipcRenderer.on('status:changed', (_e, payload) => cb(payload)),
  onOpenConnections: (cb) => ipcRenderer.on('ui:openConnections', () => cb()),

  // TikTok: datos del creador (obligatorios antes de publicar)
  tiktokCreatorInfo: () => ipcRenderer.invoke('tiktok:creatorInfo'),

  // App
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
});

contextBridge.exposeInMainWorld('alertApi', {
  onData: (cb) => ipcRenderer.on('alert:data', (_e, payload) => cb(payload)),
  action: (payload) => ipcRenderer.send('alert:action', payload),
});
