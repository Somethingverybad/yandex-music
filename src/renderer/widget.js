'use strict';
/** Логика мини-плеера: отрисовка состояния и отправка команд в main-процесс. */

const el = (id) => document.getElementById(id);

const ui = {
  cover: el('cover'),
  coverImg: el('cover-img'),
  backdropImg: el('backdrop-img'),
  title: el('title'),
  titleBox: el('title-box'),
  artist: el('artist'),
  time: el('time'),
  play: el('play'),
  playIcon: el('play-icon'),
  like: el('like'),
  download: el('download'),
  progress: el('progress'),
  progressFill: el('progress-fill'),
  progressKnob: el('progress-knob'),
  volume: el('volume'),
  volumeFill: el('volume-fill'),
  shuffle: el('shuffle'),
};

const PLAY_PATH = 'M8 5v14l11-7z';
const PAUSE_PATH = 'M6 5h4v14H6zm8 0h4v14h-4z';

let state = { paused: true, position: 0, duration: 0, hasTrack: false };
let statusTimer = null;
let seeking = false;
let settingVolume = false;   // тянем ползунок громкости
let source = 'ym';           // активный сервис: 'ym' | 'vk'

const SERVICES = {
  ym: { name: 'Яндекс Музыку', hint: 'Откройте Яндекс Музыку и включите трек' },
  vk: { name: 'ВК Музыку', hint: 'Откройте ВК Музыку и включите трек' },
};

function service() {
  return SERVICES[source] || SERVICES.ym;
}

/**
 * Активный сервис виден по акценту интерфейса: жёлтый — Яндекс Музыка,
 * синий — ВК. Отдельной подписи нет, переключается через меню виджета
 * и трея.
 */
function setSource(next) {
  source = next === 'vk' ? 'vk' : 'ym';
  document.body.classList.toggle('source-vk', source === 'vk');
  // «Мне нравится» в ВК пока не работает: кнопку добавления в свою музыку
  // приходится искать по разметке, и надёжного признака у неё нет.
  // Пока не разобрались — не показываем кнопку, которая ничего не делает.
  ui.like.classList.toggle('hidden', source === 'vk');
  ui.cover.title = 'Открыть ' + service().name;
  applyAccent();
  renderArtist();
}

/* ---------- цвет интерфейса ---------- */

// Цвет акцента для каждого сервиса; приходит из настроек
let accents = { ym: '#ffdb4d', vk: '#4aa1ff' };

function hexToRgb(hex) {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(hex).trim());
  if (!match) return null;
  return [1, 2, 3].map((i) => parseInt(match[i], 16));
}

/** Осветление для наведения: подмешиваем белый. */
function lighten(rgb, amount) {
  return rgb.map((value) => Math.round(value + (255 - value) * amount));
}

/**
 * Акцент задаётся на body, а не в таблице стилей: цвет настраивается
 * пользователем и меняется вместе с активным сервисом.
 */
function applyAccent() {
  const rgb = hexToRgb(accents[source]) || hexToRgb(accents.ym) || [255, 219, 77];
  const hover = lighten(rgb, 0.22);
  const style = document.body.style;
  style.setProperty('--accent', `rgb(${rgb.join(', ')})`);
  style.setProperty('--accent-hover', `rgb(${hover.join(', ')})`);
  style.setProperty('--accent-glow', `rgba(${rgb.join(', ')}, 0.42)`);
  style.setProperty('--accent-knob-glow', `rgba(${rgb.join(', ')}, 0.6)`);
}

/* ---------- стеклянная линза ---------- */

let lens = null;              // WebGL-линза, null если WebGL недоступен
let lensGeometry = null;      // где окно на экране (для выборки обоев)
let lensSourceKind = null;    // 'artwork' | 'image' | 'snapshot'
let lensBackdropMode = 'artwork';
let lensSourceSize = null;    // размер картинки-источника
let renderQueued = false;

// На macOS фон за окном размывает система (vibrancy), и своя линза только
// закрыла бы настоящее стекло собственной обложкой — там её не поднимаем.
// Остальные платформы работают как раньше.
let macSystemGlass = false;

function initLens() {
  if (macSystemGlass) return false;
  if (lens) return true;
  try {
    lens = new window.GlassLens(document.getElementById('glass-canvas'));
    return true;
  } catch (err) {
    console.warn('[widget] стеклянная линза недоступна:', err.message);
    lens = null;
    return false;
  }
}

/** Перерисовка не чаще кадра. */
function queueLensRender() {
  if (!lens || renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const canvas = document.getElementById('glass-canvas');
    // размеры именно панели: окно шире на прозрачные поля под тень
    lens.resize(canvas.clientWidth, canvas.clientHeight);
    applyLensCrop();
    lens.render();
  });
}

/** Сопоставляет окно и источник: обои — по позиции на экране, обложку — целиком. */
function applyLensCrop() {
  if (!lens || !lensSourceSize) return;
  if (lensSourceKind === 'snapshot') {
    // снимок уже вырезан ровно по окну
    lens.setCrop({ x: 0, y: 0, width: 1, height: 1 }, { width: 1, height: 1 });
  } else if (lensSourceKind === 'image' && lensGeometry) {
    const canvas = document.getElementById('glass-canvas');
    const pad = (window.innerWidth - canvas.clientWidth) / 2;
    lens.setCrop(
      {
        x: lensGeometry.x + pad,
        y: lensGeometry.y + pad,
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      },
      { width: lensGeometry.screenWidth, height: lensGeometry.screenHeight }
    );
  } else {
    // обложка квадратная, панель широкая — берём центральную полосу
    const canvas = document.getElementById('glass-canvas');
    lens.setCoverCrop(lensSourceSize, { width: canvas.clientWidth, height: canvas.clientHeight });
  }
}

function loadLensSource(url, kind) {
  if (!lens || !url) return;
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    lensSourceKind = kind;
    lensSourceSize = { width: image.naturalWidth, height: image.naturalHeight };
    lens.setSource(image);
    document.body.classList.add('gl-glass');
    queueLensRender();
  };
  image.onerror = () => console.warn('[widget] не удалось загрузить фон линзы:', kind);
  image.src = url;
}

/* ---------- утилиты ---------- */

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function send(command, value) {
  window.widgetApi.send(command, value);
}

/** Временное сообщение вместо строки исполнителя. */
function showStatus(message, kind) {
  clearTimeout(statusTimer);
  ui.artist.textContent = message;
  ui.artist.classList.toggle('status', kind !== 'error');
  ui.artist.classList.toggle('error', kind === 'error');
  statusTimer = setTimeout(() => {
    ui.artist.classList.remove('status', 'error');
    renderArtist();
  }, 4000);
}

function renderArtist() {
  if (ui.artist.classList.contains('status') || ui.artist.classList.contains('error')) return;
  ui.artist.textContent = state.hasTrack
    ? (state.artist || 'Неизвестный исполнитель')
    : service().hint;
}

/* ---------- отрисовка ---------- */

function renderTrack() {
  ui.title.textContent = state.hasTrack ? (state.title || 'Без названия') : 'Ничего не играет';
  renderArtist();
  document.title = state.hasTrack ? `${state.artist} — ${state.title}` : 'TheIf';

  if (state.artwork) {
    if (ui.coverImg.src !== state.artwork) ui.coverImg.src = state.artwork;
    // та же обложка идёт фоном — её и преломляет стекло
    if (ui.backdropImg.src !== state.artwork) ui.backdropImg.src = state.artwork;
    // в режиме обложки линза обновляется вместе с треком
    if (lens && lensBackdropMode === 'artwork') loadLensSource(state.artwork, 'artwork');
    ui.cover.classList.add('has-art');
    document.body.classList.add('has-art');
  } else {
    ui.cover.classList.remove('has-art');
    document.body.classList.remove('has-art');
  }

  ui.like.classList.toggle('active', state.liked === true);

  // бегущая строка только для длинных названий
  requestAnimationFrame(() => {
    const overflow = ui.title.scrollWidth - ui.titleBox.clientWidth;
    if (overflow > 4) {
      ui.titleBox.style.setProperty('--shift', `-${overflow + 24}px`);
      ui.titleBox.classList.add('scrolling');
    } else {
      ui.titleBox.classList.remove('scrolling');
    }
  });
}

function renderPlayback() {
  ui.playIcon.firstElementChild.setAttribute('d', state.paused ? PLAY_PATH : PAUSE_PATH);
  ui.play.title = state.paused ? 'Играть (Пробел)' : 'Пауза (Пробел)';
  // бегущая строка привязана к этому классу — на паузе она замирает
  document.body.classList.toggle('playing', !state.paused);
}

function renderVolume() {
  // пока тянем ползунок, состояние из плеера не перебивает жест
  if (settingVolume) return;
  const value = state.muted ? 0 : (typeof state.volume === 'number' ? state.volume : 1);
  ui.volumeFill.style.width = `${Math.max(0, Math.min(1, value)) * 100}%`;
}

function renderProgress() {
  const duration = state.duration || 0;
  const position = Math.min(state.position || 0, duration || Infinity);
  const ratio = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;
  ui.progressFill.style.width = `${ratio * 100}%`;
  ui.progressKnob.style.left = `${ratio * 100}%`;
  ui.time.textContent = `${formatTime(position)} / ${formatTime(duration)}`;
}

/* ---------- локальный тик позиции ---------- */

// Полсекунды хватает: на экране всё равно только целые секунды, а перерисовка
// прогресса идёт в окне, которое висит поверх всех остальных
setInterval(() => {
  if (state.paused || seeking || !state.duration) return;
  state.position = Math.min(state.position + 0.5, state.duration);
  renderProgress();
}, 500);

/* ---------- события от main ---------- */

window.widgetApi.onState((next) => {
  const trackChanged = next.title !== state.title || next.artist !== state.artist
    || next.artwork !== state.artwork || next.liked !== state.liked
    || next.hasTrack !== state.hasTrack;
  const playbackChanged = next.paused !== state.paused;
  state = next;
  if (trackChanged) renderTrack();
  if (playbackChanged || trackChanged) renderPlayback();
  if (!seeking) renderProgress();
  renderVolume();
});

window.widgetApi.onProgress((data) => {
  ui.download.classList.add('busy');
  const pct = data && typeof data.pct === 'number' ? data.pct : 0;
  showStatus(data && data.collection
    ? `Скачивание «${data.collection}» — ${pct}%`
    : `Скачивание — ${pct}%`);
});

window.widgetApi.onDownloadDone((result) => {
  ui.download.classList.remove('busy');
  if (result && result.ok) {
    const saved = result.saved || 0;
    const skipped = result.skipped ? `, пропущено ${result.skipped}` : '';
    showStatus(`Готово: ${saved} трек(ов)${skipped}`);
  } else {
    showStatus('Ошибка: ' + ((result && result.error) || 'неизвестно'), 'error');
  }
});

window.widgetApi.onConfig(applyConfig);

function applyConfig(cfg) {
  if (!cfg) return;
  // облегчённый вид: сплошной фон и никаких анимаций — на старых машинах
  // размытие под окном поверх всех остальных заметно греет
  document.body.classList.toggle('lite', Boolean(cfg.lite));

  // перемешивание умеет только свой плеер; в Яндексе очередью распоряжается
  // страница, и кнопке там нечего делать
  ui.shuffle.classList.toggle('hidden', !cfg.canShuffle);
  ui.shuffle.classList.toggle('active', Boolean(cfg.shuffle));
  ui.shuffle.title = cfg.shuffle ? 'Перемешивание включено' : 'Перемешать';
  if (cfg.accent) accents = { ...accents, ...cfg.accent };
  if (cfg.source) setSource(cfg.source);
  else applyAccent();
  document.body.classList.toggle('compact', Boolean(cfg.compact));
  document.body.classList.toggle('glass', cfg.glass !== false);
  document.body.classList.toggle('system-glass', Boolean(cfg.systemGlass) && cfg.glass !== false);
  document.body.classList.toggle('platform-darwin', cfg.platform === 'darwin');

  // В облегчённом виде системного размытия нет, и стекло рисует линза —
  // как на Linux. Она перерисовывается только при смене трека, а не каждый
  // кадр, поэтому старую машину греет меньше, чем vibrancy.
  macSystemGlass = cfg.platform === 'darwin' && cfg.glass !== false && !cfg.lite;
  if (macSystemGlass) lens = null;

  if (cfg.glass === false || macSystemGlass) {
    document.body.classList.remove('gl-glass');
  } else if (initLens()) {
    if (cfg.glassOptions) lens.setOptions(cfg.glassOptions);
    lensBackdropMode = ['artwork', 'image', 'snapshot'].includes(cfg.glassBackdrop)
      ? cfg.glassBackdrop : 'artwork';

    if (lensBackdropMode === 'image' && cfg.glassImage) {
      loadLensSource('file://' + encodeURI(cfg.glassImage), 'image');
    } else if (lensBackdropMode === 'artwork' && state.artwork) {
      loadLensSource(state.artwork, 'artwork');
    }
  }
  renderTrack();
  queueLensRender();
}

// снимок того, что реально лежит под виджетом — лучший источник для линзы
window.widgetApi.onBackdrop((dataUrl) => {
  if (!dataUrl || !initLens()) return;
  lensBackdropMode = 'snapshot';
  loadLensSource(dataUrl, 'snapshot');
});

window.widgetApi.onGeometry((geo) => {
  lensGeometry = geo;
  queueLensRender();
});

window.addEventListener('resize', queueLensRender);

// блик следует за курсором
window.addEventListener('mousemove', (event) => {
  if (!lens) return;
  // В облегчённом виде блик за курсором не следует: каждое движение мыши
  // перерисовывало бы линзу, а весь смысл режима — не гонять видеокарту
  if (document.body.classList.contains('lite')) return;
  lens.setPointer(event.clientX, event.clientY);
  queueLensRender();
});

// состояние линзы для отладки
window.__lensDebug = () => ({
  hasLens: Boolean(lens),
  source: lensSourceKind,
  sourceSize: lensSourceSize,
  geometry: lensGeometry,
  canvas: [document.getElementById('glass-canvas').width, document.getElementById('glass-canvas').height],
  bodyClass: document.body.className,
});

window.widgetApi.getConfig().then(applyConfig);

/* ---------- управление ---------- */

el('play').addEventListener('click', () => send('toggle'));
el('next').addEventListener('click', () => send('next'));
el('prev').addEventListener('click', () => send('prev'));
ui.like.addEventListener('click', () => send('like'));
ui.download.addEventListener('click', () => {
  ui.download.classList.add('busy');
  showStatus('Готовлю скачивание…');
  send('download');
});
ui.cover.addEventListener('click', () => send('open-service'));
ui.shuffle.addEventListener('click', () => send('toggle-shuffle'));

/* перемотка по полосе прогресса */

function seekFromEvent(event) {
  const rect = ui.progress.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  return ratio * (state.duration || 0);
}

ui.progress.addEventListener('mousedown', (event) => {
  if (!state.duration) return;
  seeking = true;
  state.position = seekFromEvent(event);
  renderProgress();
});

/* ---------- громкость ---------- */

/** Доля от ширины полосы под курсором. */
function volumeFromEvent(event) {
  const box = ui.volume.getBoundingClientRect();
  return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
}

function applyVolume(event) {
  const value = volumeFromEvent(event);
  ui.volumeFill.style.width = `${value * 100}%`;
  send('volume', value);
}

ui.volume.addEventListener('mousedown', (event) => {
  settingVolume = true;
  applyVolume(event);
});

window.addEventListener('mousemove', (event) => {
  if (settingVolume) applyVolume(event);
});

window.addEventListener('mouseup', () => {
  if (!settingVolume) return;
  settingVolume = false;
  renderVolume();
});

window.addEventListener('mousemove', (event) => {
  if (!seeking) return;
  state.position = seekFromEvent(event);
  renderProgress();
});

window.addEventListener('mouseup', (event) => {
  if (!seeking) return;
  seeking = false;
  send('seek', seekFromEvent(event));
});

/* колесо над обложкой — громкость */

ui.cover.addEventListener('wheel', (event) => {
  event.preventDefault();
  const volume = Math.max(0, Math.min(1, (state.volume || 1) - Math.sign(event.deltaY) * 0.05));
  state.volume = volume;
  send('volume', volume);
  showStatus(`Громкость ${Math.round(volume * 100)}%`);
}, { passive: false });

/* ---------- меню ---------- */

// Меню рисует main-процесс: окно виджета слишком мало, чтобы
// показать выпадающий список внутри себя — он бы обрезался.
el('menu-btn').addEventListener('click', (event) => {
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  window.widgetApi.openMenu(rect.left, rect.bottom);
});

window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.widgetApi.openMenu(event.clientX, event.clientY);
});

/* ---------- клавиатура ---------- */

window.addEventListener('keydown', (event) => {
  switch (event.code) {
    case 'Space': event.preventDefault(); send('toggle'); break;
    case 'ArrowRight': send(event.ctrlKey ? 'next' : 'seek', event.ctrlKey ? undefined : Math.min((state.position || 0) + 10, state.duration || 0)); break;
    case 'ArrowLeft': send(event.ctrlKey ? 'prev' : 'seek', event.ctrlKey ? undefined : Math.max((state.position || 0) - 10, 0)); break;
    default: break;
  }
});

renderTrack();
renderPlayback();
renderProgress();
renderVolume();
