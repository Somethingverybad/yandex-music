'use strict';
/**
 * TheIf — точка входа Electron.
 *
 * Приложение состоит из двух окон:
 *   - «большое» окно music.yandex.ru — оно же аудио-движок и полноценный
 *     интерфейс сервиса с кнопками «Скачать» (assets/inject.js);
 *   - маленький виджет поверх окон, который показывает текущий трек и
 *     управляет им; сам звук не воспроизводит, а дирижирует большим окном.
 *
 * Большое окно можно закрыть/спрятать — музыка продолжит играть,
 * приложение живёт в трее и в виджете.
 */
const fs = require('fs');
const util = require('util');
const fsp = require('fs/promises');
const path = require('path');
const {
  app, BrowserWindow, ipcMain, Menu, Tray, dialog, shell,
  screen, globalShortcut, nativeImage, desktopCapturer,
} = require('electron');

const config = require('./config');
const { YmApi } = require('./ym-api');
const { Downloader } = require('./downloader');
const nativePlayer = require('./native-player');
const mpris = require('./mpris');
const traySni = require('./tray-sni');
const wallpaper = require('./wallpaper');

const APP_URL = 'https://music.yandex.ru';
// ВК Музыка: звук играет тот же веб-плеер, что и в браузере, — приложение
// им только дирижирует. Домен vk.ru, а не vk.com: на нём работает выдача
// web_token, которой пользуется загрузчик (см. vk-api.js).
const VK_URL = 'https://vk.ru/audio';
// Страница выдачи OAuth-токена ЯМ — тот же client_id, что и в inject.js
const TOKEN_URL = 'https://oauth.yandex.ru/authorize?response_type=token'
  + '&client_id=23cabbbdc6cd418abb4b39c32c41195d';
const ROOT_DIR = path.join(__dirname, '..', '..');
const INJECT_JS = path.join(ROOT_DIR, 'src', 'inject', 'inject.js');
const PLAYER_BRIDGE_JS = path.join(ROOT_DIR, 'src', 'inject', 'player-bridge.js');
const VK_API_JS = path.join(ROOT_DIR, 'src', 'inject', 'vk-api.js');
const VK_PICKER_JS = path.join(ROOT_DIR, 'src', 'inject', 'vk-picker.js');
const ICON_PATH = path.join(ROOT_DIR, 'assets', 'icon.png');
// Монохромный силуэт для строки меню macOS; рисуется scripts/make-tray-icon.js
const TRAY_TEMPLATE_PATH = path.join(ROOT_DIR, 'assets', 'trayTemplate.png');

// Панель + прозрачные поля вокруг неё: тень должна помещаться внутрь окна,
// иначе она обрезается его границей и в углах остаются тёмные прямоугольники.
const SHADOW_PAD = 24;
const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 100;
const PANEL_HEIGHT_COMPACT = 58;

/**
 * Только macOS: vibrancy заливает весь contentView окна, поэтому прозрачные
 * поля под тень превратились бы в видимую серую рамку вокруг панели. Там окно
 * делается ровно по панели, а тень рисует система.
 *
 * На Linux и Windows поведение прежнее: поля есть, тень рисует CSS.
 */
function macSystemGlass() {
  return process.platform === 'darwin' && glassEnabled() && !liteWidget();
}

/**
 * Облегчённый вид: сплошной фон вместо системного размытия и без анимаций.
 *
 * Размытие под прозрачным окном, которое висит поверх всех остальных,
 * оконный сервер пересчитывает каждый кадр. На старых машинах это греет
 * ощутимее, чем всё остальное приложение вместе взятое.
 */
function liteWidget() {
  return Boolean(config.get('widget_lite'));
}

/**
 * На macOS стекло рисует система, оно ничего не стоит и выключать его нечем:
 * без vibrancy окно осталось бы просто прозрачным. Поэтому там оно всегда
 * включено, а из меню переключатели стекла убраны. На Linux и Windows
 * стеклянный вид по-прежнему переключается настройкой widget_glass.
 */
function glassEnabled() {
  return process.platform === 'darwin' || Boolean(config.get('widget_glass'));
}

/*
 * На macOS окно всегда делается ровно по панели: тень рисует система, а
 * прозрачные поля вокруг она обводит контуром — получается рамка. Это
 * не зависит от размытия, поэтому и в облегчённом виде полей нет.
 * На Linux и Windows поля нужны: там тень рисует CSS.
 */
function widgetPad() {
  return process.platform === 'darwin' ? 0 : SHADOW_PAD;
}

function widgetWidth() {
  return PANEL_WIDTH + widgetPad() * 2;
}

// Рекламные домены и пути — режем на уровне сети (надёжнее, чем в DOM)
const AD_URL_PATTERNS = [
  'yabs.yandex', 'an.yandex', 'adsdk.yandex', 'awaps.yandex',
  'adfox', 'ads.yandex', 'advertising.yandex', 'direct.yandex',
  'partner2.yandex', '.doubleclick.', 'adservice.', 'googlesyndication',
  '/get-killbill/', '/r/click-ad/', '/ad_', 'adlik', 'adpush',
  // Рекламная сеть ВК и myTarget: баннеры и счётчики. Сами аудио-вставки
  // сюда не попадают — они приходят с того же CDN, что и музыка, поэтому
  // их пропускает плеер (см. detectAd в player-bridge.js).
  'ads.vk.com', 'ad.mail.ru', 'rs.mail.ru', 'r.mradx.net', 'top-fwz1.mail.ru',
  'ads.mail.ru', '/al_ads.php',
];

let mainWindow = null;
let vkWindow = null;
let widgetWindow = null;
let settingsWindow = null;
let tray = null;
let api = null;
let downloader = null;
// Состояние копится по каждому источнику отдельно: неактивный сервис может
// продолжать играть, но виджет, трей и MPRIS показывают только выбранный.
let stateBySource = { ym: null, vk: null };
let lastState = null;
let quitting = false;
let saveWidgetPosTimer = null;
let wallpaperPath = null;
let capturingBackdrop = false;
let backdropTimer = null;
// с каким видом создано текущее окно виджета: размытие включается при
// создании, поэтому смена режима требует пересоздания
let appliedLite = null;

/* ------------------------------------------------------------------ */
/* Вспомогательное                                                     */
/* ------------------------------------------------------------------ */

/**
 * Дублирует консоль в файл.
 *
 * У собранного приложения вывода в терминал нет, поэтому разбираться, почему
 * что-то не сработало на другой машине, попросту не с чем. Журнал лежит в
 * ~/Library/Logs/TheIf (macOS), %APPDATA%\TheIf\logs (Windows),
 * ~/.config/TheIf/logs (Linux) и обрезается, когда разрастается.
 */
function setupFileLog() {
  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'main.log');

    try {
      if (fs.statSync(file).size > 1024 * 1024) fs.truncateSync(file, 0);
    } catch (err) { /* журнала ещё нет */ }

    const stream = fs.createWriteStream(file, { flags: 'a' });
    for (const level of ['log', 'warn', 'error']) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        original(...args);
        try {
          stream.write(`${new Date().toISOString()} ${util.format(...args)}\n`);
        } catch (err) { /* журнал не должен ломать приложение */ }
      };
    }
    console.log('[main] журнал: %s', file);
  } catch (err) {
    console.warn('[main] журнал недоступен: %s', err.message);
  }
}

/** Показывает журнал в файловом менеджере — путь к нему помнить незачем. */
function showLogFile() {
  try {
    const file = path.join(app.getPath('logs'), 'main.log');
    if (fs.existsSync(file)) shell.showItemInFolder(file);
    else shell.openPath(app.getPath('logs'));
  } catch (err) {
    console.warn('[main] не удалось открыть журнал: %s', err.message);
  }
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error('[main] не удалось прочитать %s: %s', filePath, err.message);
    return null;
  }
}

function isAdUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return AD_URL_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Картинка, запрошенная спрятанным окном сервиса.
 *
 * Такое окно работает аудио-движком, и показывать ему нечего: сотни обложек
 * и аватарок в памяти пропадают зря. Виджету они не нужны — обложку он берёт
 * по ссылке из mediaSession и грузит сам.
 *
 * Как только окно показывают, блокировка снимается; уже пропущенные места
 * заполнятся при прокрутке или переходе внутри сервиса.
 */
function isHiddenServiceImage(details) {
  if (details.resourceType !== 'image') return false;
  for (const win of [mainWindow, vkWindow]) {
    if (!win || win.isDestroyed()) continue;
    if (win.webContents.id !== details.webContentsId) continue;
    return !win.isVisible() || win.isMinimized();
  }
  return false;
}

/** Достаёт access_token из OAuth-редиректа Яндекса. */
function extractToken(url) {
  if (!url || url.indexOf('access_token=') < 0) return null;
  const match = url.match(/[#&?]access_token=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function toastInPage(message, isError) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const safe = JSON.stringify(String(message));
  mainWindow.webContents.executeJavaScript(
    `window.__ymToast && window.__ymToast(${safe}, ${Boolean(isError)});`
  ).catch(() => {});
}

function sendToWidget(channel, payload) {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send(channel, payload);
  }
}

/* ---------- источники музыки ---------- */

/** Активный сервис: им управляют виджет, трей, медиа-клавиши и MPRIS. */
function activeSource() {
  const source = config.get('source');
  if (source === 'vk' && config.get('vk_enabled')) return 'vk';
  return 'ym';
}

/**
 * Играет ли ВК своим плеером. В этом режиме страница сервиса — только
 * каталог: она не звучит, а выбранную очередь подхватывает окно-движок.
 */
function vkNative() {
  return config.get('vk_native_player') !== false;
}

function sourceWindow(source) {
  const win = source === 'vk' ? vkWindow : mainWindow;
  return win && !win.isDestroyed() ? win : null;
}

/** Окно, которое сейчас играет и слушает команды. */
function activeWindow() {
  return sourceWindow(activeSource());
}

/** К какому источнику относится окно, приславшее событие. */
function sourceOfContents(contents) {
  if (vkWindow && !vkWindow.isDestroyed() && contents === vkWindow.webContents) return 'vk';
  return 'ym';
}

/** Выполняет метод драйвера плеера в странице активного сервиса. */
function playerCall(method, ...args) {
  // ВК со своим плеером командуется напрямую, страница тут ни при чём
  if (activeSource() === 'vk' && vkNative()) {
    const result = nativePlayer.command(method, args[0]);
    console.log('[main] vk (свой плеер): %s -> %s', method, result);
    return Promise.resolve(result);
  }

  const win = activeWindow();
  if (!win) return Promise.resolve(false);
  const argsJson = args.map((a) => JSON.stringify(a)).join(', ');
  return win.webContents
    .executeJavaScript(`window.__ymPlayer && window.__ymPlayer.${method}(${argsJson});`)
    .then((result) => {
      console.log('[main] %s: %s -> %s', activeSource(), method, result);
      return result;
    })
    .catch((err) => {
      console.warn('[main] playerCall(%s) не удался: %s', method, err.message);
      return false;
    });
}

/**
 * Состояние приходит из двух мест: из моста в странице сервиса и из
 * собственного плеера. Формат общий, поэтому обработка одна.
 */
function handlePlayerState(source, state) {
  if (!state) return;
  const previous = stateBySource[source];
  stateBySource[source] = state;

  if (!previous || previous.paused !== state.paused || previous.title !== state.title) {
    console.log('[main] состояние %s: «%s» %s (id=%s)', source, state.title || '—',
      state.paused ? 'пауза' : 'играет', state.trackId || '—');
  }

  if (source !== activeSource()) {
    // Заиграл неактивный сервис — значит пользователь хочет слушать именно
    // его. Двух песен сразу не допускаем: он становится активным, прежний
    // глушится (см. setSource).
    if (state.paused === false) setSource(source);
    return;
  }

  const trackChanged = !lastState || lastState.title !== state.title
    || lastState.artist !== state.artist;
  const pausedChanged = !lastState || lastState.paused !== state.paused;
  lastState = state;
  sendToWidget('player:state', state);
  mpris.update(state);
  if (trackChanged || pausedChanged) rebuildTrayMenu();
}

/** Ставит на паузу сервис, который перестал быть активным. */
function pauseSource(source) {
  if (source === 'vk' && vkNative()) {
    nativePlayer.command('pause');
    return;
  }
  const win = sourceWindow(source);
  if (!win) return;
  win.webContents
    .executeJavaScript('window.__ymPlayer && window.__ymPlayer.pause();')
    .catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Окно Яндекс Музыки                                                  */
/* ------------------------------------------------------------------ */

/** Мост плеера — общий для ЯМ и ВК: профиль выбирается по домену страницы. */
function injectPlayerBridge(contents) {
  const bridge = readFileSafe(PLAYER_BRIDGE_JS);
  if (!bridge) return;
  contents.executeJavaScript(bridge)
    .then((result) => console.log('[main] player-bridge внедрён:', result))
    .catch((err) => console.warn('[main] player-bridge:', err.message));
}

/** Пропуск аудиорекламы включён тем же переключателем, что и блокировщик. */
function applyAdSkip(contents) {
  const enabled = Boolean(config.get('block_ads'));
  contents.executeJavaScript(`window.__ymSkipAds = ${enabled};`).catch(() => {});
}

/**
 * Запоминает id вошедшего пользователя ВК.
 *
 * Он нужен как ключ распаковки ссылок на файлы, а знает его только страница.
 * Сохранив id один раз, приложение обходится без неё: окно ВК открывается
 * ради входа и выбора музыки, играет же собственный плеер (см. vk-api.js).
 */
function rememberVkUser(contents) {
  contents.executeJavaScript('window.vk && window.vk.id ? String(window.vk.id) : null;')
    .then((id) => {
      if (!id || id === '0' || id === config.get('vk_user_id')) return;
      config.set('vk_user_id', id);
      config.save();
      console.log('[main] ВК: пользователь %s', id);
    })
    .catch(() => {});
}

/** Перехват выбора музыки: страница отдаёт очередь собственному плееру. */
function injectVkPicker(contents) {
  const script = readFileSafe(VK_PICKER_JS);
  if (!script) return;
  contents.executeJavaScript(script)
    .then((result) => console.log('[main] vk-picker внедрён:', result))
    .catch((err) => console.warn('[main] vk-picker:', err.message));
}

/** Клиент аудио ВК: живёт в странице, чтобы ходить с её cookie и Origin. */
function injectVkApi(contents) {
  const script = readFileSafe(VK_API_JS);
  if (!script) return;
  contents.executeJavaScript(script)
    .then((result) => console.log('[main] vk-api внедрён:', result))
    .catch((err) => console.warn('[main] vk-api:', err.message));
}

function injectScripts(contents) {
  const inject = readFileSafe(INJECT_JS);
  injectPlayerBridge(contents);
  if (inject) {
    contents.executeJavaScript(inject)
      .then(() => console.log('[main] inject.js внедрён'))
      .catch((err) => console.warn('[main] inject.js:', err.message));
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Яндекс Музыка',
    icon: ICON_PATH,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT_DIR, 'src', 'preload', 'yandex.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // фоновое окно должно продолжать играть музыку и слать состояние
      backgroundThrottling: false,
    },
  });

  mainWindow.loadURL(APP_URL);

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] страница загружена, внедряю скрипты');
    injectScripts(mainWindow.webContents);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.warn('[main] загрузка не удалась (%s): %s %s', code, description, url);
  });
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[main] ошибка preload %s: %s', preloadPath, error.message);
  });
  // SPA-навигация внутри ЯМ не перезагружает документ, но после
  // «жёстких» переходов скрипты нужно внедрить заново
  mainWindow.webContents.on('did-navigate', (_event, url) => {
    const token = extractToken(url);
    if (token) acceptToken(token);
  });
  mainWindow.webContents.on('did-navigate-in-page', () => injectScripts(mainWindow.webContents));

  // Ссылки наружу: OAuth и паспорт открываем во внутреннем окне,
  // остальное — в системном браузере
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAdUrl(url)) return { action: 'deny' };
    if (/(oauth|passport)\.yandex\./.test(url)) {
      openAuthWindow(url);
      return { action: 'deny' };
    }
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!quitting && config.get('close_to_tray')) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  if (!config.get('start_hidden')) {
    mainWindow.once('ready-to-show', () => mainWindow.show());
  }

  if (process.env.YMW_DEV) {
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/* ------------------------------------------------------------------ */
/* Окно ВК Музыки                                                      */
/* ------------------------------------------------------------------ */

/**
 * Окно ВК — каталог: в нём ищут и выбирают музыку, а звук идёт из окна-движка
 * (см. native-player.js). Страница заглушается, выбранная очередь уходит
 * своему плееру, и окно можно закрыть — музыка продолжит играть.
 *
 * При выключенном vk_native_player работает прежняя схема: звук играет сам
 * веб-плеер сервиса, а приложение читает состояние через player-bridge.
 */
function createVkWindow() {
  vkWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'ВК Музыка',
    icon: ICON_PATH,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT_DIR, 'src', 'preload', 'vk.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  vkWindow.loadURL(VK_URL);

  vkWindow.webContents.on('did-finish-load', () => {
    console.log('[main] страница ВК загружена');
    applyAdSkip(vkWindow.webContents);
    // со своим плеером страница только каталог: мост ей не нужен,
    // вместо него — перехват выбора музыки
    if (vkNative()) injectVkPicker(vkWindow.webContents);
    else injectPlayerBridge(vkWindow.webContents);
    injectVkApi(vkWindow.webContents);
    rememberVkUser(vkWindow.webContents);
  });
  vkWindow.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.warn('[main] ВК: загрузка не удалась (%s): %s %s', code, description, url);
  });
  vkWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[main] ВК: ошибка preload %s: %s', preloadPath, error.message);
  });
  // VK — SPA: переход между разделами не перезагружает документ
  // VK — SPA: после перехода между разделами скрипты нужно внедрить заново.
  // Со своим плеером это перехватчик выбора: мост читал бы заглушённый
  // элемент страницы и спорил с движком о том, играет музыка или нет.
  vkWindow.webContents.on('did-navigate-in-page', () => {
    if (vkNative()) injectVkPicker(vkWindow.webContents);
    else injectPlayerBridge(vkWindow.webContents);
  });

  vkWindow.webContents.setWindowOpenHandler(({ url }) => {
    // авторизация и внутренние ссылки VK остаются в окне приложения,
    // остальное уходит в системный браузер
    if (/^https:\/\/([a-z0-9-]+\.)?(vk\.ru|vk\.com|login\.vk\.ru)\//.test(url)) {
      vkWindow.loadURL(url);
      return { action: 'deny' };
    }
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  vkWindow.on('close', (event) => {
    if (!quitting && config.get('close_to_tray')) {
      event.preventDefault();
      vkWindow.hide();
    }
  });

  const win = vkWindow;
  win.on('closed', () => { if (vkWindow === win) vkWindow = null; });

  if (process.env.YMW_DEV) {
    vkWindow.once('ready-to-show', () => vkWindow.show());
    vkWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function showVkWindow() {
  if (!config.get('vk_enabled')) {
    config.set('vk_enabled', true);
    config.save();
  }
  if (!vkWindow || vkWindow.isDestroyed()) {
    createVkWindow();
    vkWindow.once('ready-to-show', () => vkWindow.show());
    return;
  }
  if (!vkWindow.isVisible()) vkWindow.show();
  if (vkWindow.isMinimized()) vkWindow.restore();
  vkWindow.focus();
}

/**
 * Переключает активный сервис. Играет всегда ровно один: все остальные
 * источники ставятся на паузу — иначе два веб-плеера звучали бы вместе.
 */
function setSource(source) {
  const next = source === 'vk' ? 'vk' : 'ym';
  if (next === activeSource()) return;

  for (const other of ['ym', 'vk']) {
    if (other !== next) pauseSource(other);
  }
  config.set('source', next);
  config.save();

  // Окно нужного сервиса могло ещё не подниматься — оно создаётся по
  // требованию, чтобы не держать в памяти страницу, которой не пользуются
  // Со своим плеером страница ВК не нужна: её открывают вручную, чтобы
  // войти и выбрать музыку, а звук идёт из окна-движка
  if (next === 'vk' && !vkNative() && !sourceWindow('vk')) {
    config.set('vk_enabled', true);
    config.save();
    createVkWindow();
  }
  if (next === 'ym' && !sourceWindow('ym')) createMainWindow();

  lastState = stateBySource[next];
  sendToWidget('player:config', { source: next });
  sendToWidget('widget:config', widgetConfig());
  if (lastState) sendToWidget('player:state', lastState);
  mpris.update(lastState);
  rebuildTrayMenu();
}

/* ------------------------------------------------------------------ */
/* Окно настроек                                                       */
/* ------------------------------------------------------------------ */

/**
 * Настройки живут в своём окне, а не модалкой внутри страницы ЯМ: половина
 * параметров общая для сервисов, и открывать ради них Яндекс Музыку, когда
 * слушаешь ВК, бессмысленно.
 */
function showSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 560,
    height: 700,
    minWidth: 460,
    minHeight: 520,
    title: 'Настройки',
    icon: ICON_PATH,
    backgroundColor: '#17171a',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(ROOT_DIR, 'src', 'preload', 'settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.loadFile(path.join(ROOT_DIR, 'src', 'renderer', 'settings.html'));

  const win = settingsWindow;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { if (settingsWindow === win) settingsWindow = null; });
}

/** Окно авторизации/получения токена с перехватом access_token. */
function openAuthWindow(url) {
  const authWindow = new BrowserWindow({
    width: 520,
    height: 720,
    parent: mainWindow || undefined,
    title: 'Авторизация Яндекс',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  authWindow.loadURL(url);

  const check = (targetUrl) => {
    const token = extractToken(targetUrl);
    if (token) {
      acceptToken(token);
      if (!authWindow.isDestroyed()) authWindow.close();
    }
  };
  authWindow.webContents.on('will-redirect', (_e, targetUrl) => check(targetUrl));
  authWindow.webContents.on('did-navigate', (_e, targetUrl) => check(targetUrl));
  authWindow.webContents.on('did-navigate-in-page', (_e, targetUrl) => check(targetUrl));
}

/** Сохраняет пойманный токен и сообщает об этом в интерфейс. */
async function acceptToken(token) {
  try {
    config.saveToken(token);
  } catch (err) {
    toastInPage('Не удалось сохранить токен: ' + err.message, true);
    return;
  }
  const valid = await api.validateToken();
  toastInPage(valid
    ? 'Токен сохранён — скачивание доступно'
    : 'Токен сохранён, но проверка не пройдена', !valid);
  sendToWidget('auth:changed', { authorized: true });
}

/* ------------------------------------------------------------------ */
/* Виджет                                                              */
/* ------------------------------------------------------------------ */

function widgetHeight() {
  const panel = config.get('widget_compact') ? PANEL_HEIGHT_COMPACT : PANEL_HEIGHT;
  return panel + widgetPad() * 2;
}

/** Меняет размер виджета: у неизменяемого окна setSize молча игнорируется. */
function applyWidgetSize() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  widgetWindow.setResizable(true);
  widgetWindow.setSize(widgetWidth(), widgetHeight(), false);
  widgetWindow.setResizable(false);
}

function defaultWidgetPosition() {
  // угол того экрана, где сейчас курсор — на многомониторной системе
  // виджет не должен уезжать на «главный» монитор
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  return {
    x: area.x + area.width - widgetWidth() - 24,
    y: area.y + area.height - widgetHeight() - 24,
  };
}

/**
 * Держит виджет в пределах экрана: панель нельзя утащить за край так,
 * чтобы её нельзя было поймать мышью обратно.
 */
function clampWidgetPosition(x, y) {
  const width = widgetWidth();
  const height = widgetHeight();
  // ищем экран, которого окно касается; если ни одного — возвращаем на главный
  const display = screen.getDisplayMatching({ x, y, width, height })
    || screen.getPrimaryDisplay();
  const area = display.workArea;

  // хотя бы столько панели должно остаться на виду
  const visible = 60;
  const minX = area.x - (width - widgetPad() - visible);
  const maxX = area.x + area.width - widgetPad() - visible;
  const minY = area.y - widgetPad();
  const maxY = area.y + area.height - widgetPad() - visible;

  return {
    x: Math.round(Math.min(Math.max(x, minX), maxX)),
    y: Math.round(Math.min(Math.max(y, minY), maxY)),
  };
}

function createWidget() {
  const saved = { x: config.get('widget_x'), y: config.get('widget_y') };
  const position = (saved.x != null && saved.y != null)
    ? clampWidgetPosition(saved.x, saved.y)
    : defaultWidgetPosition();

  widgetWindow = new BrowserWindow({
    width: widgetWidth(),
    height: widgetHeight(),
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    // Сворачивание нужно, чтобы виджет можно было убрать в панель задач
    minimizable: true,
    fullscreenable: false,
    skipTaskbar: !config.get('widget_in_taskbar'),
    alwaysOnTop: config.get('widget_always_on_top'),
    // Настоящее системное стекло — размывается то, что за окном.
    // Такого API нет только на Linux: Mutter не даёт приложениям
    // размывать содержимое под своим окном.
    ...(macSystemGlass()
      ? { vibrancy: config.get('mac_vibrancy') || 'hud', visualEffectState: 'active' } : {}),
    ...(config.get('widget_glass') && process.platform === 'win32'
      ? { backgroundMaterial: 'acrylic' } : {}),
    title: 'TheIf',
    icon: ICON_PATH,
    show: false,
    webPreferences: {
      preload: path.join(ROOT_DIR, 'src', 'preload', 'widget.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  appliedLite = liteWidget();
  widgetWindow.loadFile(path.join(ROOT_DIR, 'src', 'renderer', 'widget.html'));
  widgetWindow.setOpacity(config.get('widget_opacity'));
  if (config.get('widget_always_on_top')) {
    widgetWindow.setAlwaysOnTop(true, 'screen-saver');
    widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  // Свёрнутый виджет не должен висеть поверх окон — иначе часть оболочек
  // возвращает его на экран сразу после сворачивания
  widgetWindow.on('minimize', () => {
    if (!widgetWindow.isDestroyed()) widgetWindow.setAlwaysOnTop(false);
  });
  widgetWindow.on('restore', () => {
    if (!widgetWindow.isDestroyed() && config.get('widget_always_on_top')) {
      widgetWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  });

  if (process.env.YMW_DEV) widgetWindow.webContents.openDevTools({ mode: 'detach' });

  // Окно берём по локальной ссылке: старое окно шлёт 'closed' уже после того,
  // как пересоздание положило в widgetWindow новое, и глобальная ссылка в этот
  // момент может быть null.
  const win = widgetWindow;
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.show();
    sendWidgetGeometry();
    if (lastState) sendToWidget('player:state', lastState);
  });

  // Запоминаем положение (с задержкой, чтобы не писать файл на каждый пиксель)
  widgetWindow.on('move', () => {
    sendWidgetGeometry();
    clearTimeout(saveWidgetPosTimer);
    saveWidgetPosTimer = setTimeout(() => {
      if (!widgetWindow || widgetWindow.isDestroyed()) return;
      const [x, y] = widgetWindow.getPosition();
      const safe = clampWidgetPosition(x, y);
      if (safe.x !== x || safe.y !== y) widgetWindow.setPosition(safe.x, safe.y);
      config.set('widget_x', safe.x);
      config.set('widget_y', safe.y);
      config.save();
    }, 700);
  });

  // Сбрасываем ссылку только если закрылось именно текущее окно: иначе
  // 'closed' от пересозданного окна обнулит уже созданное ему на замену.
  win.on('closed', () => { if (widgetWindow === win) widgetWindow = null; });
}

/**
 * Меню виджета — нативное: HTML-меню обрезалось бы границами окна 360×100.
 * Координаты приходят из рендерера в пикселях относительно окна.
 */
function showWidgetMenu(x, y) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    {
      label: 'Играет: Яндекс Музыка',
      type: 'checkbox',
      checked: activeSource() === 'ym',
      click: () => setSource('ym'),
    },
    {
      label: 'Играет: ВК Музыка',
      type: 'checkbox',
      checked: activeSource() === 'vk',
      click: () => setSource('vk'),
    },
    { type: 'separator' },
    { label: 'Открыть Яндекс Музыку', click: showMainWindow },
    { label: 'Открыть ВК Музыку', click: showVkWindow },
    { label: 'Скачать текущий трек', click: () => downloadCurrentTrack() },
    { label: 'Открыть папку с музыкой', click: () => openDownloadsFolder() },
    { label: 'Настройки…', click: showSettingsWindow },
    { label: 'Показать журнал', click: showLogFile },
    { type: 'separator' },
    {
      label: 'Компактный вид',
      type: 'checkbox',
      checked: Boolean(config.get('widget_compact')),
      click: () => handleWidgetCommand('toggle-compact'),
    },
    {
      label: 'Поверх всех окон',
      type: 'checkbox',
      checked: Boolean(config.get('widget_always_on_top')),
      click: () => handleWidgetCommand('toggle-on-top'),
    },
    // Выбор фона под линзой и сам переключатель стекла нужны только там,
    // где стекло рисует виджет. На маке размывает система: линзы нет,
    // выключать нечего — пункты в меню не показываем.
    ...(process.platform === 'darwin' ? [] : [
      {
        label: 'Фон стекла: обложка трека',
        type: 'checkbox',
        checked: config.get('glass_backdrop') === 'artwork',
        click: () => handleWidgetCommand('glass-artwork'),
      },
      {
        label: 'Фон стекла: своя картинка…',
        type: 'checkbox',
        checked: config.get('glass_backdrop') === 'image',
        click: () => handleWidgetCommand('glass-image'),
      },
      {
        label: 'Фон стекла: снимок экрана',
        type: 'checkbox',
        checked: config.get('glass_backdrop') === 'snapshot',
        click: () => handleWidgetCommand('glass-snapshot'),
      },
      {
        label: 'Стеклянный вид',
        type: 'checkbox',
        checked: Boolean(config.get('widget_glass')),
        click: () => handleWidgetCommand('toggle-glass'),
      },
    ]),
    {
      label: 'Показывать в панели задач',
      type: 'checkbox',
      checked: Boolean(config.get('widget_in_taskbar')),
      click: () => handleWidgetCommand('toggle-taskbar'),
    },
    { type: 'separator' },
    { label: 'Вернуть виджет на место', click: () => handleWidgetCommand('reset-position') },
    { label: 'Свернуть в панель задач', click: minimizeWidget },
    { label: 'Выключить виджет', click: toggleWidget },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]);
  menu.popup({
    window: widgetWindow,
    x: Math.round(x || 0),
    y: Math.round(y || 0),
  });
}

/** Открывает каталог загрузок в файловом менеджере системы. */
async function openDownloadsFolder() {
  const target = config.get('download_path');
  try {
    await fsp.mkdir(target, { recursive: true });
  } catch (err) {
    console.warn('[main] не удалось создать каталог загрузок: %s', err.message);
  }
  const error = await shell.openPath(target);
  if (error) console.warn('[main] не удалось открыть папку загрузок: %s', error);
}

/** Выбор своей картинки под стекло — альтернатива снимку экрана без запросов. */
async function pickGlassImage() {
  const result = await dialog.showOpenDialog({
    title: 'Картинка под стекло виджета',
    defaultPath: config.get('glass_backdrop_image') || wallpaperPath || app.getPath('pictures'),
    filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return;
  config.set('glass_backdrop_image', result.filePaths[0]);
  config.set('glass_backdrop', 'image');
  config.save();
  sendToWidget('widget:config', widgetConfig());
}

/**
 * Снимает участок экрана под виджетом и отдаёт его линзе.
 *
 * Рендерер не видит ничего за пределами своего окна, поэтому «то, что под
 * стеклом» приходится добывать снимком экрана. Виджет на один кадр
 * прячется, иначе попал бы в собственный снимок.
 *
 * Вызывается только по явной команде: в GNOME/Wayland захват экрана идёт
 * через xdg-desktop-portal и показывает системный запрос разрешения —
 * дёргать его самостоятельно приложение не должно.
 */
async function captureWidgetBackdrop() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  // На маке линзы нет, а лишний захват экрана поднял бы системный запрос
  // разрешения на запись экрана — там снимок не нужен вовсе.
  if (process.platform === 'darwin') return;
  if (!config.get('widget_glass')) return;
  if (capturingBackdrop) return;
  capturingBackdrop = true;

  const bounds = widgetWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const wasVisible = widgetWindow.isVisible() && !widgetWindow.isMinimized();

  try {
    if (wasVisible) widgetWindow.hide();
    await new Promise((resolve) => setTimeout(resolve, 90));

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: display.size.width, height: display.size.height },
    });
    const source = sources.find((entry) => String(entry.display_id) === String(display.id))
      || sources[0];
    if (!source || source.thumbnail.isEmpty()) return;

    const shot = source.thumbnail.crop({
      x: Math.max(0, bounds.x - display.bounds.x + widgetPad()),
      y: Math.max(0, bounds.y - display.bounds.y + widgetPad()),
      width: Math.max(1, bounds.width - widgetPad() * 2),
      height: Math.max(1, bounds.height - widgetPad() * 2),
    });
    sendToWidget('widget:backdrop', shot.toDataURL());
  } catch (err) {
    console.warn('[main] снимок фона под виджетом не удался:', err.message);
  } finally {
    if (wasVisible && widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.show();
    capturingBackdrop = false;
  }
}

/**
 * Сообщает виджету, где он находится на экране: рендерер подставляет
 * ровно тот участок обоев, который оказался под окном.
 */
function sendWidgetGeometry() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const [x, y] = widgetWindow.getPosition();
  const display = screen.getDisplayNearestPoint({ x, y });
  sendToWidget('widget:geometry', {
    x: x - display.bounds.x,
    y: y - display.bounds.y,
    screenWidth: display.bounds.width,
    screenHeight: display.bounds.height,
    scaleFactor: display.scaleFactor,
  });
}

/** Показывает виджет: создаёт, если он был выключен, и разворачивает свёрнутый. */
function showWidget() {
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    config.set('widget_enabled', true);
    config.save();
    createWidget();
    rebuildTrayMenu();
    return;
  }
  if (widgetWindow.isMinimized()) widgetWindow.restore();
  if (!widgetWindow.isVisible()) widgetWindow.show();
  widgetWindow.focus();
}

/** Убирает виджет в панель задач — вернуть можно кликом по его иконке. */
function minimizeWidget() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  if (config.get('widget_in_taskbar')) {
    widgetWindow.minimize();
  } else {
    // Без иконки в панели задач сворачивать некуда — прячем совсем,
    // вернуть можно из трея
    widgetWindow.hide();
  }
}

function toggleWidget() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.close();
    config.set('widget_enabled', false);
  } else {
    config.set('widget_enabled', true);
    createWidget();
  }
  config.save();
  rebuildTrayMenu();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    mainWindow.once('ready-to-show', () => mainWindow.show());
    return;
  }
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/* ------------------------------------------------------------------ */
/* Трей                                                                */
/* ------------------------------------------------------------------ */

/** Единый шаблон меню трея — годится и для Electron Menu, и для dbusmenu. */
function trayMenuTemplate() {
  return [
    { label: lastState && lastState.title ? `${lastState.artist} — ${lastState.title}` : 'Ничего не играет', enabled: false },
    { type: 'separator' },
    { label: lastState && !lastState.paused ? 'Пауза' : 'Играть', click: () => playerCall('toggle') },
    { label: 'Следующий трек', click: () => playerCall('next') },
    { label: 'Предыдущий трек', click: () => playerCall('prev') },
    { type: 'separator' },
    {
      label: 'Играет: Яндекс Музыка',
      type: 'checkbox',
      checked: activeSource() === 'ym',
      click: () => setSource('ym'),
    },
    {
      label: 'Играет: ВК Музыка',
      type: 'checkbox',
      checked: activeSource() === 'vk',
      click: () => setSource('vk'),
    },
    { type: 'separator' },
    { label: 'Открыть Яндекс Музыку', click: showMainWindow },
    { label: 'Открыть ВК Музыку', click: showVkWindow },
    { label: 'Показать виджет', click: () => showWidget() },
    { label: 'Вернуть виджет на место', click: () => handleWidgetCommand('reset-position') },
    {
      label: 'Виджет включён',
      type: 'checkbox',
      checked: Boolean(widgetWindow && !widgetWindow.isDestroyed()),
      click: toggleWidget,
    },
    { label: 'Скачать текущий трек', click: () => downloadCurrentTrack() },
    { label: 'Открыть папку с музыкой', click: () => openDownloadsFolder() },
    { label: 'Настройки…', click: showSettingsWindow },
    { label: 'Показать журнал', click: showLogFile },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ];
}

function trayTooltip() {
  return lastState && lastState.title
    ? `${lastState.artist} — ${lastState.title}`
    : 'TheIf';
}

function rebuildTrayMenu() {
  const template = trayMenuTemplate();
  if (traySni.isActive()) {
    traySni.setMenu(template);
    traySni.setTooltip(trayTooltip());
    return;
  }
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(trayTooltip());
}

/**
 * Значок для строки меню.
 *
 * На macOS там ждут template-образ: монохромный силуэт 16 pt, который система
 * сама красит под тему и подсвечивает при нажатии. Цветная иконка приложения
 * выглядит рядом с нативными значками чужеродно и крупно. Файл @2x рядом
 * Electron подхватывает сам.
 *
 * На Linux и Windows шаблонных образов нет — там прежняя цветная иконка.
 */
function trayImage() {
  if (process.platform === 'darwin') {
    const template = nativeImage.createFromPath(TRAY_TEMPLATE_PATH);
    if (!template.isEmpty()) {
      template.setTemplateImage(true);
      return template;
    }
  }
  return nativeImage.createFromPath(ICON_PATH).resize({ width: 32, height: 32 });
}

async function createTray() {
  const image = trayImage();

  // Сначала пробуем собственный StatusNotifierItem: в GNOME он рисуется
  // корректно, в отличие от встроенного Tray
  const started = await traySni.start({
    id: 'theif',
    title: 'TheIf',
    image,
    onActivate: () => showWidget(),
    menuItems: trayMenuTemplate(),
  });
  if (started) return;

  try {
    tray = new Tray(image);
    tray.on('click', () => showWidget());
    rebuildTrayMenu();
  } catch (err) {
    console.warn('[main] трей недоступен:', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Скачивание                                                          */
/* ------------------------------------------------------------------ */

function reportProgress(payload) {
  sendToWidget('download:progress', payload);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents
      .executeJavaScript(`window.__ymProgress && window.__ymProgress(${payload.pct || 0});`)
      .catch(() => {});
  }
}

/** Скачивание трека, который сейчас играет (кнопка на виджете и в трее). */
/**
 * Скачивание из ВК. Прямую ссылку на файл знает только страница vk.ru —
 * там есть и cookie сессии, и ключ распаковки адреса, поэтому её добывает
 * vk-api.js, а main лишь сохраняет файл и проставляет теги.
 */
async function downloadCurrentVkTrack() {
  const win = sourceWindow('vk');
  if (!win) {
    sendToWidget('download:done', { ok: false, error: 'Окно ВК Музыки не открыто' });
    return;
  }

  try {
    const track = await win.webContents.executeJavaScript(
      'window.__vkApi && window.__vkApi.currentTrack();'
    );
    if (!track) throw new Error('Сейчас ничего не играет');

    // ffmpeg тянет сегменты сам, и для ВК важно представляться так же,
    // как окно приложения, — иначе CDN может отказать
    track.userAgent = win.webContents.getUserAgent();

    sendToWidget('download:progress', { pct: 0, title: track.title });
    const result = await downloader.saveDirectTrack(track);
    sendToWidget('download:done', result);
  } catch (err) {
    console.error('[main] скачивание трека ВК:', err.message);
    sendToWidget('download:done', { ok: false, error: err.message });
  }
}

async function downloadCurrentTrack() {
  if (activeSource() === 'vk') return downloadCurrentVkTrack();

  if (!config.isAuthorized()) {
    showMainWindow();
    playerCall('openToken');
    sendToWidget('download:done', { ok: false, error: 'Нужен токен Яндекс Музыки' });
    return;
  }
  const state = lastState;
  if (!state || !state.hasTrack) {
    sendToWidget('download:done', { ok: false, error: 'Сейчас ничего не играет' });
    return;
  }

  try {
    let trackId = state.trackId;
    if (!trackId) {
      // id не удалось вытащить из плеер-бара — ищем трек по названию
      const found = await api.searchTrack(`${state.artist} ${state.title}`.trim());
      trackId = found && found.id;
    }
    if (!trackId) throw new Error('Не удалось определить трек');

    sendToWidget('download:progress', { pct: 0, title: state.title });
    const result = await downloader.downloadTrack(String(trackId));
    sendToWidget('download:done', result);
  } catch (err) {
    console.error('[main] скачивание текущего трека:', err.message);
    sendToWidget('download:done', { ok: false, error: err.message });
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  /* --- мост pywebview для inject.js --- */

  ipcMain.handle('ym:is-authorized', () => config.isAuthorized());

  ipcMain.handle('ym:save-token', async (_event, token) => {
    try {
      config.saveToken(token);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const valid = await api.validateToken();
    sendToWidget('auth:changed', { authorized: true });
    return valid
      ? { ok: true }
      : { ok: true, warning: 'Токен сохранён, но проверка не пройдена. Возможно, он неверен.' };
  });

  ipcMain.handle('ym:get-settings', () => config.asDict());

  ipcMain.handle('ym:save-settings', (_event, settings) => {
    try {
      const saved = config.update(settings);
      applyRuntimeSettings();
      return { ok: true, settings: saved };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('ym:browse-download-path', async () => {
    const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const result = await dialog.showOpenDialog(target, {
      title: 'Куда сохранять музыку',
      defaultPath: config.get('download_path'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return { cancelled: true };
    return { path: result.filePaths[0] };
  });

  ipcMain.handle('ym:my-uid', async () => {
    try {
      return { uid: await api.myUid() };
    } catch (err) {
      return { uid: null };
    }
  });

  ipcMain.handle('ym:download', async (_event, { id, type }) => {
    try {
      return await downloader.downloadItem(id, type, { jobId: `${type}:${id}` });
    } catch (err) {
      console.error('[main] скачивание %s:%s — %s', type, id, err.message);
      return { ok: false, error: err.message };
    }
  });

  /* --- состояние плеера из страницы ЯМ --- */

  ipcMain.on('player:state', (event, state) => {
    handlePlayerState(sourceOfContents(event.sender), state);
  });

  ipcMain.on('player:log', (_event, message) => console.log('[page]', message));

  /* --- выбор музыки в каталоге ВК --- */

  ipcMain.on('vk:pick', (_event, payload) => {
    if (!vkNative() || !payload || !Array.isArray(payload.tracks)) return;
    const { tracks, index } = payload;
    if (!tracks.length) return;

    // выбор в каталоге делает ВК активным сервисом — иначе виджет
    // показывал бы Яндекс, пока звучит ВК
    if (activeSource() !== 'vk') setSource('vk');

    /*
     * Одиночный трек приходит и тогда, когда очередь у страницы просто
     * пропала: ВК делает служебный редирект на login.php, перезагружает
     * себя, и плеер страницы начинает с чистого списка. Если этот трек уже
     * стоит в нашей очереди, переключаемся на него и очередь сохраняем —
     * иначе плейлист из сотен треков заменялся бы одной песней, и листать
     * становилось нечем.
     */
    if (tracks.length === 1) {
      const known = nativePlayer.positionOf(tracks[0].id);
      if (known >= 0) {
        console.log('[main] ВК: трек %d из очереди в %d — очередь сохраняем',
          known + 1, nativePlayer.queueLength());
        nativePlayer.playAt(known);
        return;
      }
    }

    console.log('[main] ВК: очередь из %d треков, играет %d-й', tracks.length, index + 1);
    nativePlayer.playQueue(tracks, index);
  });

  /* --- окно настроек --- */

  ipcMain.handle('settings:open-token-page', () => {
    openAuthWindow(TOKEN_URL);
    return { ok: true };
  });

  /*
   * Предпросмотр: прозрачность и цвет виджета применяются на лету, пока
   * пользователь двигает ползунок. В файл ничего не пишем — это делает
   * кнопка «Сохранить», поэтому закрытое без сохранения окно ничего
   * не меняет насовсем (значения вернутся при следующем запуске).
   */
  ipcMain.on('settings:preview', (_event, patch) => {
    if (!patch || typeof patch !== 'object') return;
    for (const key of ['widget_opacity', 'widget_accent_ym', 'widget_accent_vk']) {
      if (patch[key] !== undefined) config.set(key, patch[key]);
    }
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.setOpacity(config.get('widget_opacity'));
      sendToWidget('widget:config', widgetConfig());
    }
  });

  ipcMain.on('settings:open-vk', () => showVkWindow());

  ipcMain.on('settings:close', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  });

  /* --- команды от виджета --- */

  ipcMain.on('widget:command', (_event, { command, value }) => handleWidgetCommand(command, value));

  ipcMain.on('widget:menu', (_event, position) => {
    showWidgetMenu(position && position.x, position && position.y);
  });

  ipcMain.handle('widget:get-config', () => {
    setImmediate(sendWidgetGeometry);
    return widgetConfig();
  });
}

/** Обработка команд виджета — вызывается и по IPC, и из нативного меню. */
function handleWidgetCommand(command, value) {
  switch (command) {
    case 'play': playerCall('play'); break;
    case 'pause': playerCall('pause'); break;
    case 'toggle': playerCall('toggle'); break;
    case 'next': playerCall('next'); break;
    case 'prev': playerCall('prev'); break;
    case 'seek': playerCall('seek', value); break;
    case 'volume': playerCall('setVolume', value); break;
    case 'like': playerCall('like'); break;
    case 'download': downloadCurrentTrack(); break;
    case 'refresh-backdrop': captureWidgetBackdrop(); break;
    case 'open-downloads': openDownloadsFolder(); break;
    case 'toggle-shuffle': {
      // перемешивание есть только у своего плеера: в Яндексе очередью
      // распоряжается сама страница
      if (activeSource() !== 'vk' || !vkNative()) break;
      const on = nativePlayer.setShuffle(!config.get('vk_shuffle'));
      config.set('vk_shuffle', on);
      config.save();
      sendToWidget('widget:config', widgetConfig());
      break;
    }
    case 'set-source': setSource(value); break;
    case 'toggle-source': setSource(activeSource() === 'ym' ? 'vk' : 'ym'); break;
    case 'open-service': (activeSource() === 'vk' ? showVkWindow : showMainWindow)(); break;

    case 'reset-position': {
      const position = defaultWidgetPosition();
      config.set('widget_x', position.x);
      config.set('widget_y', position.y);
      config.save();
      if (widgetWindow && !widgetWindow.isDestroyed()) {
        widgetWindow.setPosition(position.x, position.y);
        showWidget();
      }
      break;
    }

    case 'glass-artwork':
      config.set('glass_backdrop', 'artwork');
      config.save();
      sendToWidget('widget:config', widgetConfig());
      break;

    case 'glass-image':
      pickGlassImage();
      break;

    case 'glass-snapshot':
      config.set('glass_backdrop', 'snapshot');
      config.save();
      sendToWidget('widget:config', widgetConfig());
      captureWidgetBackdrop();
      break;
    case 'open-main': showMainWindow(); break;
    case 'settings': showMainWindow(); playerCall('openSettings'); break;
    case 'hide-widget': minimizeWidget(); break;
    case 'toggle-glass': {
      // на маке стекло системное и не выключается — см. glassEnabled()
      if (process.platform === 'darwin') break;
      config.set('widget_glass', !config.get('widget_glass'));
      config.save();
      sendToWidget('widget:config', widgetConfig());
      // системное стекло задаётся при создании окна — пересоздаём его
      if (['darwin', 'win32'].includes(process.platform)
          && widgetWindow && !widgetWindow.isDestroyed()) {
        widgetWindow.close();
        createWidget();
      }
      break;
    }
    case 'toggle-taskbar': {
      const inTaskbar = !config.get('widget_in_taskbar');
      config.set('widget_in_taskbar', inTaskbar);
      config.save();
      if (widgetWindow && !widgetWindow.isDestroyed()) {
        widgetWindow.setSkipTaskbar(!inTaskbar);
      }
      sendToWidget('widget:config', widgetConfig());
      break;
    }
    case 'quit': quitting = true; app.quit(); break;
    case 'toggle-compact': {
      config.set('widget_compact', !config.get('widget_compact'));
      config.save();
      applyWidgetSize();
      sendToWidget('widget:config', widgetConfig());
      break;
    }
    case 'toggle-on-top': {
      const next = !config.get('widget_always_on_top');
      config.set('widget_always_on_top', next);
      config.save();
      if (widgetWindow && !widgetWindow.isDestroyed()) {
        widgetWindow.setAlwaysOnTop(next, 'screen-saver');
      }
      sendToWidget('widget:config', widgetConfig());
      break;
    }
    default: break;
  }
}

function widgetConfig() {
  return {
    compact: config.get('widget_compact'),
    alwaysOnTop: config.get('widget_always_on_top'),
    inTaskbar: config.get('widget_in_taskbar'),
    source: activeSource(),
    lite: liteWidget(),
    // перемешивание умеет только свой плеер
    canShuffle: activeSource() === 'vk' && vkNative(),
    shuffle: Boolean(config.get('vk_shuffle')),
    vkEnabled: Boolean(config.get('vk_enabled')),
    accent: {
      ym: config.get('widget_accent_ym'),
      vk: config.get('widget_accent_vk'),
    },
    glass: glassEnabled(),
    glassOptions: config.get('glass_options'),
    glassBackdrop: config.get('glass_backdrop'),
    glassImage: config.get('glass_backdrop_image') || wallpaperPath,
    // в облегчённом виде системного размытия нет, значит и стилям о нём
    // знать незачем — иначе панель осталась бы прозрачной
    systemGlass: !liteWidget() && ['darwin', 'win32'].includes(process.platform),
    platform: process.platform,
    wallpaper: wallpaperPath,
    opacity: config.get('widget_opacity'),
    authorized: config.isAuthorized(),
  };
}

/** Применяет настройки, влияющие на уже созданные окна. */
function applyRuntimeSettings() {
  // Размытие включается при создании окна, поэтому переход в облегчённый
  // вид и обратно требует пересоздания — заодно меняются поля под тень
  if (appliedLite !== null && appliedLite !== liteWidget()
      && widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.close();
    createWidget();
  }

  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.setOpacity(config.get('widget_opacity'));
    widgetWindow.setAlwaysOnTop(config.get('widget_always_on_top'), 'screen-saver');
    // материал стекла на маке меняется без пересоздания окна
    if (macSystemGlass()) widgetWindow.setVibrancy(config.get('mac_vibrancy') || 'hud');
    const vk = sourceWindow('vk');
    if (vk) applyAdSkip(vk.webContents);
    applyWidgetSize();
    sendToWidget('widget:config', widgetConfig());
  }
}

/* ------------------------------------------------------------------ */
/* Запуск                                                              */
/* ------------------------------------------------------------------ */

function setupSession() {
  const { session } = require('electron');
  const ses = session.defaultSession;

  // Блокировка рекламных запросов и картинок в скрытых окнах сервисов
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (config.get('block_ads') && isAdUrl(details.url)) {
      callback({ cancel: true });
      return;
    }
    if (isHiddenServiceImage(details)) {
      callback({ cancel: true });
      return;
    }
    callback({});
  });

  // Убираем из User-Agent следы Electron — сайт должен видеть обычный Chrome
  app.userAgentFallback = app.userAgentFallback
    .replace(/\s?(TheIf|Electron)\/[\d.]+/g, '');
}

function registerMediaKeys() {
  const bindings = {
    MediaPlayPause: () => playerCall('toggle'),
    MediaNextTrack: () => playerCall('next'),
    MediaPreviousTrack: () => playerCall('prev'),
    MediaStop: () => playerCall('pause'),
  };
  for (const [accelerator, handler] of Object.entries(bindings)) {
    try {
      globalShortcut.register(accelerator, handler);
    } catch (err) {
      // На Wayland глобальные хоткеи недоступны — управление идёт через MPRIS
      console.warn('[main] не удалось зарегистрировать %s: %s', accelerator, err.message);
    }
  }
}

// Настройки читаем до старта: выбор графического бэкенда нужно
// применить раньше, чем Chromium инициализирует окна.
config.init();

/**
 * Выбор графического бэкенда на Linux.
 *
 * Chromium определяет ozone-платформу раньше, чем выполняется этот файл,
 * поэтому appendSwitch здесь уже не действует — флаг должен стоять в
 * командной строке. Если его нет, перезапускаем себя с ним: это дешевле
 * одного холодного старта и избавляет от падений на системах, где
 * нативный Wayland-бэкенд Chromium нестабилен.
 */
// Виджет управляет воспроизведением программно, без клика по странице,
// поэтому политику автовоспроизведения нужно ослабить — иначе Chromium
// отклоняет play() как вызов без действия пользователя.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (process.platform === 'linux') {
  // Бэкенд системного хранилища ключей для safeStorage
  const store = config.get('password_store');
  if (store && store !== 'auto') app.commandLine.appendSwitch('password-store', store);

  const platform = config.get('ozone_platform');
  const alreadySet = process.argv.some((arg) => arg.startsWith('--ozone-platform'));
  if (platform && platform !== 'auto' && !alreadySet) {
    const options = { args: process.argv.slice(1).concat([`--ozone-platform=${platform}`]) };
    // Внутри AppImage перезапускаться нужно самим образом, а не распакованным
    // бинарником: у того нет окружения, которое готовит AppRun. Флаг
    // --appimage-extract-and-run обязателен — в системах без FUSE (Ubuntu 24+
    // не ставит libfuse2) образ иначе не смонтируется.
    if (process.env.APPIMAGE) {
      options.execPath = process.env.APPIMAGE;
      options.args.unshift('--appimage-extract-and-run');
    }
    console.log('[main] перезапуск с --ozone-platform=%s', platform);
    app.relaunch(options);
    app.exit(0);
  }
}

/*
 * При выходе шина DBus закрывается раньше, чем оболочка успевает получить
 * ответ на последний запрос к трею или MPRIS. dbus-next в этот момент
 * бросает «Cannot send message, stream is closed» уже вне наших вызовов,
 * и Electron показывает окно с ошибкой. Такие разрывы глушим, всё
 * остальное честно показываем.
 */
const SHUTDOWN_NOISE = /stream is closed|Bus is not connected|EPIPE|Connection reset/i;

process.on('uncaughtException', (error) => {
  const message = (error && error.message) || String(error);
  if (quitting || SHUTDOWN_NOISE.test(message)) {
    console.warn('[main] ошибка при завершении (игнорируем): %s', message);
    return;
  }
  console.error('[main] необработанное исключение:', error);
  dialog.showErrorBox('TheIf', message);
});

process.on('unhandledRejection', (reason) => {
  const message = (reason && reason.message) || String(reason);
  if (quitting || SHUTDOWN_NOISE.test(message)) return;
  console.error('[main] необработанный отказ промиса:', reason);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWidget());

  app.whenReady().then(() => {
    setupFileLog();
    config.initSecureStorage();
    api = new YmApi(() => config.getToken());
    downloader = new Downloader(api, config);
    downloader.setProgressCallback(reportProgress);

    setupSession();
    registerIpc();

    // Свой плеер для ВК: состояние отдаёт в том же виде, что и мост в
    // странице, поэтому виджету, трею и MPRIS всё равно, кто играет
    nativePlayer.init({
      getUserId: () => config.get('vk_user_id'),
      onState: (state) => handlePlayerState('vk', state),
      onError: (message) => sendToWidget('download:done', { ok: false, error: message }),
    });
    // возвращаем последнюю очередь: трек встаёт на паузу там, где его
    // оставили, — раньше это помнил сайт, теперь помним сами
    if (vkNative() && config.get('vk_enabled')) nativePlayer.restore();
    wallpaper.find().then((found) => {
      wallpaperPath = found;
      if (found) {
        console.log('[main] обои для стекла: %s', found);
        sendToWidget('widget:config', widgetConfig());
        sendWidgetGeometry();
      }
    });
    // Каждое окно сервиса — полноценная страница Chromium (~300 МБ), поэтому
    // поднимаем только то, которым сейчас пользуются. Второе создаётся при
    // переключении источника или по команде «Открыть …» из меню.
    // Для ВК со своим плеером окно не нужно вовсе: оно открывается вручную,
    // чтобы войти и выбрать музыку.
    if (activeSource() === 'ym') createMainWindow();
    else if (!vkNative() && config.get('vk_enabled')) createVkWindow();
    if (config.get('widget_enabled')) createWidget();
    createTray();
    registerMediaKeys();
    mpris.start({
      onCommand: (command, value) => {
        if (command === 'seek') playerCall('seek', value);
        else playerCall(command);
      },
      getState: () => lastState,
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Живём в трее: закрытие окон не завершает приложение
    if (process.platform === 'darwin') return;
    if (!tray && !traySni.isActive()) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    mpris.stop();
    traySni.stop();
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });
}
