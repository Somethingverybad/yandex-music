'use strict';
/**
 * Preload для окна music.yandex.ru.
 *
 * 1. Выставляет window.pywebview.api — точную копию моста из Python-версии,
 *    благодаря чему assets/inject.js (кнопки «Скачать», модалки токена и
 *    настроек) переносится в Electron без изменений.
 * 2. Выставляет window.__ymHost — канал, через который скрипт player-bridge.js
 *    из главного мира отдаёт состояние плеера в main-процесс.
 */
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  is_authorized: () => ipcRenderer.invoke('ym:is-authorized'),
  save_token: (token) => ipcRenderer.invoke('ym:save-token', token),
  get_settings: () => ipcRenderer.invoke('ym:get-settings'),
  save_settings: (settings) => ipcRenderer.invoke('ym:save-settings', settings),
  browse_download_path: () => ipcRenderer.invoke('ym:browse-download-path'),
  download: (id, type) => ipcRenderer.invoke('ym:download', { id, type }),
  get_my_uid: () => ipcRenderer.invoke('ym:my-uid'),
};

contextBridge.exposeInMainWorld('pywebview', { api });

contextBridge.exposeInMainWorld('__ymHost', {
  publish: (state) => ipcRenderer.send('player:state', state),
  log: (message) => ipcRenderer.send('player:log', String(message)),
});
