'use strict';
/**
 * Интеграция с MPRIS (Linux): благодаря ней приложение появляется в
 * панели GNOME/KDE, а аппаратные медиа-клавиши работают даже в Wayland,
 * где globalShortcut недоступен.
 *
 * На Windows/macOS модуль просто ничего не делает.
 */
let player = null;
let lastTrackKey = '';
let currentState = null;

function start({ onCommand, getState }) {
  if (process.platform !== 'linux') return;

  let Player;
  try {
    Player = require('mpris-service');
  } catch (err) {
    console.warn('[mpris] модуль недоступен:', err.message);
    return;
  }

  try {
    player = Player({
      name: 'yamusicwidget',
      identity: 'YaMusic Widget',
      supportedInterfaces: ['player'],
      supportedUriSchemes: [],
      supportedMimeTypes: [],
    });
  } catch (err) {
    console.warn('[mpris] не удалось подключиться к DBus:', err.message);
    player = null;
    return;
  }

  player.canSeek = true;
  player.canControl = true;
  player.canGoNext = true;
  player.canGoPrevious = true;
  player.canPlay = true;
  player.canPause = true;
  player.playbackStatus = 'Stopped';
  player.getPosition = () => {
    const state = getState && getState();
    return state ? Math.round((state.position || 0) * 1e6) : 0;
  };

  player.on('play', () => onCommand('play'));
  player.on('pause', () => onCommand('pause'));
  player.on('playpause', () => onCommand('toggle'));
  player.on('stop', () => onCommand('pause'));
  player.on('next', () => onCommand('next'));
  player.on('previous', () => onCommand('prev'));
  player.on('position', (event) => onCommand('seek', Number(event.position) / 1e6));
  player.on('seek', (offset) => {
    const state = getState && getState();
    const base = state ? state.position || 0 : 0;
    onCommand('seek', base + Number(offset) / 1e6);
  });

  console.log('[mpris] сервис запущен');
}

function update(state) {
  if (!player || !state) return;
  currentState = state;
  try {
    const key = `${state.artist}|${state.title}|${Math.round(state.duration || 0)}`;
    if (key !== lastTrackKey) {
      lastTrackKey = key;
      player.metadata = {
        'mpris:trackid': player.objectPath('track/' + Math.abs(hash(key))),
        'mpris:length': Math.round((state.duration || 0) * 1e6),
        'mpris:artUrl': state.artwork || '',
        'xesam:title': state.title || '',
        'xesam:album': state.album || '',
        'xesam:artist': state.artist ? [state.artist] : [],
      };
    }
    const status = !state.hasTrack ? 'Stopped' : (state.paused ? 'Paused' : 'Playing');
    if (player.playbackStatus !== status) player.playbackStatus = status;
  } catch (err) {
    console.warn('[mpris] обновление не удалось:', err.message);
  }
}

function hash(text) {
  let value = 0;
  for (let i = 0; i < text.length; i += 1) {
    value = ((value << 5) - value + text.charCodeAt(i)) | 0;
  }
  return value;
}

function stop() {
  currentState = null;
  if (player && typeof player.disconnect === 'function') {
    try { player.disconnect(); } catch (_) { /* уже отключён */ }
  }
  player = null;
}

module.exports = { start, update, stop };
