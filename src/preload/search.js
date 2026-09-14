'use strict';
/** Preload окна поиска: запрос, воспроизведение и скачивание по позиции. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('searchApi', {
  search: (query) => ipcRenderer.invoke('search:query', query),
  play: (position) => ipcRenderer.send('search:play', position),
  download: (position) => ipcRenderer.invoke('search:download', position),
  close: () => ipcRenderer.send('search:close'),
});
