'use strict';
/** Preload виджета: узкий безопасный мост в main-процесс. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetApi', {
  send: (command, value) => ipcRenderer.send('widget:command', { command, value }),
  openMenu: (x, y) => ipcRenderer.send('widget:menu', { x, y }),
  getConfig: () => ipcRenderer.invoke('widget:get-config'),
  onState: (callback) => ipcRenderer.on('player:state', (_e, state) => callback(state)),
  onConfig: (callback) => ipcRenderer.on('widget:config', (_e, cfg) => callback(cfg)),
  onGeometry: (callback) => ipcRenderer.on('widget:geometry', (_e, geo) => callback(geo)),
  onBackdrop: (callback) => ipcRenderer.on('widget:backdrop', (_e, dataUrl) => callback(dataUrl)),
  onProgress: (callback) => ipcRenderer.on('download:progress', (_e, data) => callback(data)),
  onDownloadDone: (callback) => ipcRenderer.on('download:done', (_e, data) => callback(data)),
  onAuthChanged: (callback) => ipcRenderer.on('auth:changed', (_e, data) => callback(data)),
});
