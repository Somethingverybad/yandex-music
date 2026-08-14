'use strict';
/** Preload окна-движка: узкий канал команд и состояния. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('playerHost', {
  ready: () => ipcRenderer.send('native:ready'),
  state: (state) => ipcRenderer.send('native:state', state),
  ended: () => ipcRenderer.send('native:ended'),
  error: (message) => ipcRenderer.send('native:error', String(message)),
  onCommand: (callback) => ipcRenderer.on('native:command', (_e, payload) => callback(payload)),
});
