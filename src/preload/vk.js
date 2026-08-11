'use strict';
/**
 * Preload для окна vk.ru.
 *
 * Отличий от окна ЯМ два:
 *   1. кнопок «Скачать» в интерфейс не внедряется, поэтому моста pywebview
 *      здесь нет — только канал состояния плеера;
 *   2. запросы к аудио-эндпоинтам ВК делаются самой страницей (см. vk-api.js
 *      в main): там уже есть нужные cookie и правильный Origin, а main лишь
 *      просит страницу выполнить запрос и забирает результат.
 *
 * Имя канала оставлено общим с ЯМ (__ymHost): player-bridge.js один на оба
 * сервиса и публикует состояние туда же.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__ymHost', {
  publish: (state) => ipcRenderer.send('player:state', state),
  log: (message) => ipcRenderer.send('player:log', String(message)),
});
