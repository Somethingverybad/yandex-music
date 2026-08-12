'use strict';
/** Preload окна настроек: узкий мост к тем же обработчикам, что и у inject.js. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('ym:get-settings'),
  save: (patch) => ipcRenderer.invoke('ym:save-settings', patch),
  browsePath: () => ipcRenderer.invoke('ym:browse-download-path'),
  saveToken: (token) => ipcRenderer.invoke('ym:save-token', token),
  isAuthorized: () => ipcRenderer.invoke('ym:is-authorized'),
  getToken: () => ipcRenderer.invoke('settings:open-token-page'),
  // применить, не записывая в файл: сохранение — по кнопке
  preview: (patch) => ipcRenderer.send('settings:preview', patch),
  openVk: () => ipcRenderer.send('settings:open-vk'),
  close: () => ipcRenderer.send('settings:close'),
});
