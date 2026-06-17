/*
 * preload.js — Puente seguro entre el renderer y el proceso principal.
 * Expone window.api (calendario) y window.alertApi (ventana trascendental).
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

  // Conexiones / integraciones
  connectionsSummary: () => ipcRenderer.invoke('connections:summary'),
  getMeta: () => ipcRenderer.invoke('connections:getMeta'),
  saveMeta: (data) => ipcRenderer.invoke('connections:saveMeta', data),
  testMeta: (creds) => ipcRenderer.invoke('connections:testMeta', creds),
  publishNow: (task) => ipcRenderer.invoke('content:publishNow', task),
});

contextBridge.exposeInMainWorld('alertApi', {
  onData: (cb) => ipcRenderer.on('alert:data', (_e, payload) => cb(payload)),
  action: (payload) => ipcRenderer.send('alert:action', payload),
});
