'use strict';
/**
 * Собственный плеер: окно-движок плюс очередь воспроизведения.
 *
 * Раньше музыку играла страница сервиса, а приложение ею дирижировало.
 * Здесь наоборот: страница нужна только для входа и выбора, а играет
 * скрытое окно с одним <audio> (см. renderer/player.js). Ссылки на файлы
 * берутся напрямую через vk-api, поэтому держать сайт в памяти не нужно.
 *
 * Ссылка на файл живёт недолго, поэтому перед каждым треком её запрашиваем
 * заново — по идентификатору из очереди.
 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const vkApi = require('./vk-api');

const ROOT_DIR = path.join(__dirname, '..', '..');

// Очередь лежит отдельным файлом, а не в настройках: в ней бывают сотни
// треков, и перезаписывать из-за них весь settings.json незачем
const STATE_FILE = 'vk-queue.json';
const MAX_SAVED = 500;

let win = null;
let ready = false;
let pending = [];        // команды, пришедшие до готовности окна

let queue = [];          // список треков: { id, accessKey, title, artist, ... }
let index = -1;
let hooks = {};          // onState, onEnded, onError
let getUserId = () => null;

/* ------------------------------------------------------------------ */
/* Окно                                                                */
/* ------------------------------------------------------------------ */

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;

  win = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    webPreferences: {
      preload: path.join(ROOT_DIR, 'src', 'preload', 'player.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // окно скрыто, но музыка не должна останавливаться вместе с таймерами
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(ROOT_DIR, 'src', 'renderer', 'player.html'));

  const current = win;
  current.on('closed', () => {
    if (win === current) {
      win = null;
      ready = false;
    }
  });

  return win;
}

function send(command, value) {
  const target = ensureWindow();
  if (!ready) {
    pending.push({ command, value });
    return;
  }
  target.webContents.send('native:command', { command, value });
}

/* ------------------------------------------------------------------ */
/* Очередь                                                             */
/* ------------------------------------------------------------------ */

/** Заряжает трек по позиции в очереди, попутно обновив ссылку на файл. */
async function loadIndex(at, autoplay = true, startAt = 0) {
  if (at < 0 || at >= queue.length) return false;
  index = at;
  const item = queue[index];

  try {
    const fresh = await vkApi.track(item.id, item.accessKey, getUserId());
    if (!fresh || !fresh.url) throw new Error('нет ссылки на файл');
    // метаданные из очереди полнее: там есть альбом и обложка из выдачи
    queue[index] = { ...item, ...fresh };
    send('load', { track: queue[index], autoplay, startAt });
    return true;
  } catch (err) {
    if (hooks.onError) hooks.onError(`${item.artist} — ${item.title}: ${err.message}`);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Память между запусками                                              */
/* ------------------------------------------------------------------ */

let position = 0;        // где остановились в текущем треке
let saveTimer = null;

function statePath() {
  return path.join(app.getPath('userData'), STATE_FILE);
}

/**
 * Сохраняет очередь, позицию в ней и место в треке.
 *
 * Раньше, где остановились, помнил сайт; со своим плеером помнить приходится
 * самим, иначе после перезапуска пусто. Ссылки на файлы не храним — они
 * протухают за считанные часы и всё равно запрашиваются заново.
 */
function persist() {
  clearTimeout(saveTimer);
  // после смены трека и на паузе состояние сыплется часто, поэтому пишем
  // файл не чаще раза в пару секунд
  saveTimer = setTimeout(() => {
    if (!queue.length || index < 0) return;
    const payload = {
      index,
      position,
      tracks: queue.slice(0, MAX_SAVED).map(({ id, accessKey, title, artist, duration, cover }) => (
        { id, accessKey, title, artist, duration, cover }
      )),
    };
    try {
      fs.writeFileSync(statePath(), JSON.stringify(payload), 'utf8');
    } catch (err) {
      console.warn('[native] не удалось сохранить очередь: %s', err.message);
    }
  }, 2000);
}

/**
 * Возвращает последнюю очередь. Трек заряжается на паузе и с того места,
 * где его оставили: продолжать самому — дело пользователя.
 */
function restore() {
  let saved = null;
  try {
    const file = statePath();
    if (!fs.existsSync(file)) return false;
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn('[native] не удалось прочитать очередь: %s', err.message);
    return false;
  }

  if (!saved || !Array.isArray(saved.tracks) || !saved.tracks.length) return false;

  queue = saved.tracks;
  const at = Number.isInteger(saved.index) ? saved.index : 0;
  console.log('[native] восстановлена очередь: %d треков, позиция %d', queue.length, at + 1);
  loadIndex(Math.max(0, Math.min(at, queue.length - 1)), false, Number(saved.position) || 0);
  return true;
}

/* ------------------------------------------------------------------ */
/* Публичное                                                           */
/* ------------------------------------------------------------------ */

function init(options = {}) {
  hooks = options;
  if (options.getUserId) getUserId = options.getUserId;

  ipcMain.on('native:ready', () => {
    ready = true;
    const queued = pending;
    pending = [];
    for (const item of queued) send(item.command, item.value);
  });

  ipcMain.on('native:state', (_event, state) => {
    if (state && state.hasTrack) {
      position = state.position || 0;
      persist();
    }
    if (hooks.onState) hooks.onState(state);
  });

  ipcMain.on('native:ended', () => {
    // доиграл — сам переходим к следующему, очередь знает только main
    if (index + 1 < queue.length) loadIndex(index + 1);
    else if (hooks.onEnded) hooks.onEnded();
  });

  ipcMain.on('native:error', (_event, message) => {
    console.warn('[native] %s', message);
    if (hooks.onError) hooks.onError(message);
  });
}

/** Ставит очередь и начинает играть с указанной позиции. */
function playQueue(tracks, position = 0) {
  queue = Array.isArray(tracks) ? tracks.filter(Boolean) : [];
  return loadIndex(position);
}

function command(name, value) {
  switch (name) {
    case 'next':
      if (index + 1 < queue.length) loadIndex(index + 1);
      return true;
    case 'prev':
      if (index > 0) loadIndex(index - 1);
      return true;
    default:
      send(name, value);
      return true;
  }
}

/** Играет ли что-нибудь: по этому признаку выбирается активный источник. */
function hasTrack() {
  return index >= 0 && index < queue.length;
}

function stop() {
  queue = [];
  index = -1;
  send('stop');
}

/** Закрывает окно-движок: музыка останавливается, память освобождается. */
function shutdown() {
  stop();
  if (win && !win.isDestroyed()) win.close();
  win = null;
  ready = false;
}

module.exports = { init, playQueue, command, hasTrack, stop, shutdown, restore };
