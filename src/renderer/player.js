'use strict';
/**
 * Движок воспроизведения: один <audio> и ничего лишнего.
 *
 * ВК отдаёт музыку плейлистом m3u8, который Chromium сам не играет, поэтому
 * потоки разбирает hls.js. Обычные файлы (так отдаёт Яндекс Музыка) уходят
 * прямо в src — без лишнего слоя.
 *
 * Наружу отдаём то же состояние, что раньше собирал мост в странице сервиса,
 * так что виджету, трею и MPRIS всё равно, кто именно играет.
 */

const audio = document.getElementById('audio');

let hls = null;          // экземпляр hls.js, пока играет поток
let track = null;        // что сейчас заряжено
let publishTimer = null;

/* ---------- загрузка трека ---------- */

function releaseStream() {
  if (!hls) return;
  hls.destroy();
  hls = null;
}

function load(next, autoplay) {
  track = next || null;
  releaseStream();

  if (!track || !track.url) {
    audio.removeAttribute('src');
    audio.load();
    publish(true);
    return;
  }

  const isStream = /\.m3u8(\?|$)/i.test(track.url);

  if (isStream && window.Hls && window.Hls.isSupported()) {
    hls = new window.Hls({ enableWorker: true, lowLatencyMode: false });
    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      // фатальную ошибку наверх: main решит, пропускать трек или нет
      if (data && data.fatal) fail(data.details || 'ошибка потока');
    });
    hls.loadSource(track.url);
    hls.attachMedia(audio);
    if (autoplay) hls.on(window.Hls.Events.MANIFEST_PARSED, () => play());
  } else {
    audio.src = track.url;
    audio.load();
    if (autoplay) play();
  }

  publish(true);
}

function play() {
  const promise = audio.play();
  // до первого взаимодействия Chromium может отклонить автозапуск —
  // в main для этого ослаблена политика автовоспроизведения
  if (promise && promise.catch) promise.catch((err) => fail(err.message));
}

function fail(message) {
  window.playerHost.error(String(message || 'неизвестная ошибка'));
}

/* ---------- состояние ---------- */

function state() {
  const duration = isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : (track && track.duration) || 0;

  return {
    service: 'vk',
    title: (track && track.title) || '',
    artist: (track && track.artist) || '',
    album: (track && track.album) || '',
    artwork: (track && track.cover) || '',
    trackId: (track && track.id) || null,
    duration,
    position: audio.currentTime || 0,
    paused: audio.paused,
    volume: audio.volume,
    muted: audio.muted,
    liked: null,
    hasTrack: Boolean(track),
  };
}

function publish(force) {
  clearTimeout(publishTimer);
  window.playerHost.state(state());
  // пока играет, шлём позицию раз в полсекунды — реже, чем timeupdate
  if (!audio.paused) publishTimer = setTimeout(() => publish(), 500);
  else if (force) { /* разовая публикация уже сделана */ }
}

['play', 'pause', 'loadedmetadata', 'seeked'].forEach((name) => {
  audio.addEventListener(name, () => publish(true));
});

audio.addEventListener('ended', () => window.playerHost.ended());
audio.addEventListener('error', () => {
  const error = audio.error;
  fail(error ? `код ${error.code}` : 'не удалось воспроизвести');
});

/* ---------- команды из main ---------- */

window.playerHost.onCommand(({ command, value }) => {
  switch (command) {
    case 'load': load(value && value.track, value && value.autoplay !== false); break;
    case 'play': play(); break;
    case 'pause': audio.pause(); break;
    case 'toggle': audio.paused ? play() : audio.pause(); break;
    case 'stop': load(null, false); break;
    case 'seek':
      if (isFinite(audio.duration)) audio.currentTime = Math.max(0, Math.min(value, audio.duration));
      break;
    case 'setVolume':
      audio.volume = Math.max(0, Math.min(1, Number(value)));
      audio.muted = false;
      publish(true);
      break;
    default: break;
  }
});

window.playerHost.ready();
