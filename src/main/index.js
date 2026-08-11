'use strict';
/**
 * YaMusic Widget — точка входа Electron.
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
const path = require('path');
const {
  app, BrowserWindow, ipcMain, Menu, Tray, dialog, shell,
  screen, globalShortcut, nativeImage, desktopCapturer,
} = require('electron');

const config = require('./config');
const { YmApi } = require('./ym-api');
const { Downloader } = require('./downloader');
const mpris = require('./mpris');
const traySni = require('./tray-sni');
const wallpaper = require('./wallpaper');

const APP_URL = 'https://music.yandex.ru';
const ROOT_DIR = path.join(__dirname, '..', '..');
const INJECT_JS = path.join(ROOT_DIR, 'src', 'inject', 'inject.js');
const PLAYER_BRIDGE_JS = path.join(ROOT_DIR, 'src', 'inject', 'player-bridge.js');
const ICON_PATH = path.join(ROOT_DIR, 'assets', 'icon.png');

// Панель + прозрачные поля вокруг неё: тень должна помещаться внутрь окна,
// иначе она обрезается его границей и в углах остаются тёмные прямоугольники.
const WIDGET_PAD = 24;
const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 100;
const PANEL_HEIGHT_COMPACT = 58;

const WIDGET_WIDTH = PANEL_WIDTH + WIDGET_PAD * 2;
const WIDGET_HEIGHT = PANEL_HEIGHT + WIDGET_PAD * 2;
const WIDGET_HEIGHT_COMPACT = PANEL_HEIGHT_COMPACT + WIDGET_PAD * 2;

// Рекламные домены и пути — режем на уровне сети (надёжнее, чем в DOM)
const AD_URL_PATTERNS = [
  'yabs.yandex', 'an.yandex', 'adsdk.yandex', 'awaps.yandex',
  'adfox', 'ads.yandex', 'advertising.yandex', 'direct.yandex',
  'partner2.yandex', '.doubleclick.', 'adservice.', 'googlesyndication',
  '/get-killbill/', '/r/click-ad/', '/ad_', 'adlik', 'adpush',
];

let mainWindow = null;
let widgetWindow = null;
let tray = null;
let api = null;
let downloader = null;
let lastState = null;
let quitting = false;
let saveWidgetPosTimer = null;
let wallpaperPath = null;
let capturingBackdrop = false;
let backdropTimer = null;

/* ------------------------------------------------------------------ */
/* Вспомогательное                                                     */
/* ------------------------------------------------------------------ */

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

/** Выполняет метод драйвера плеера в странице ЯМ. */
function playerCall(method, ...args) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);
  const argsJson = args.map((a) => JSON.stringify(a)).join(', ');
  return mainWindow.webContents
    .executeJavaScript(`window.__ymPlayer && window.__ymPlayer.${method}(${argsJson});`)
    .catch((err) => {
      console.warn('[main] playerCall(%s) не удался: %s', method, err.message);
      return false;
    });
}

/* ------------------------------------------------------------------ */
/* Окно Яндекс Музыки                                                  */
/* ------------------------------------------------------------------ */

function injectScripts(contents) {
  const bridge = readFileSafe(PLAYER_BRIDGE_JS);
  const inject = readFileSafe(INJECT_JS);
  if (bridge) {
    contents.executeJavaScript(bridge)
      .then((result) => console.log('[main] player-bridge внедрён:', result))
      .catch((err) => console.warn('[main] player-bridge:', err.message));
  }
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
  return config.get('widget_compact') ? WIDGET_HEIGHT_COMPACT : WIDGET_HEIGHT;
}

/** Меняет размер виджета: у неизменяемого окна setSize молча игнорируется. */
function applyWidgetSize() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  widgetWindow.setResizable(true);
  widgetWindow.setSize(WIDGET_WIDTH, widgetHeight(), false);
  widgetWindow.setResizable(false);
}

function defaultWidgetPosition() {
  // угол того экрана, где сейчас курсор — на многомониторной системе
  // виджет не должен уезжать на «главный» монитор
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  return {
    x: area.x + area.width - WIDGET_WIDTH - 24,
    y: area.y + area.height - widgetHeight() - 24,
  };
}

/**
 * Держит виджет в пределах экрана: панель нельзя утащить за край так,
 * чтобы её нельзя было поймать мышью обратно.
 */
function clampWidgetPosition(x, y) {
  const width = WIDGET_WIDTH;
  const height = widgetHeight();
  // ищем экран, которого окно касается; если ни одного — возвращаем на главный
  const display = screen.getDisplayMatching({ x, y, width, height })
    || screen.getPrimaryDisplay();
  const area = display.workArea;

  // хотя бы столько панели должно остаться на виду
  const visible = 60;
  const minX = area.x - (width - WIDGET_PAD - visible);
  const maxX = area.x + area.width - WIDGET_PAD - visible;
  const minY = area.y - WIDGET_PAD;
  const maxY = area.y + area.height - WIDGET_PAD - visible;

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
    width: WIDGET_WIDTH,
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
    ...(config.get('widget_glass') && process.platform === 'darwin'
      ? { vibrancy: 'under-window', visualEffectState: 'active' } : {}),
    ...(config.get('widget_glass') && process.platform === 'win32'
      ? { backgroundMaterial: 'acrylic' } : {}),
    title: 'YaMusic Widget',
    icon: ICON_PATH,
    show: false,
    webPreferences: {
      preload: path.join(ROOT_DIR, 'src', 'preload', 'widget.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

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

  widgetWindow.once('ready-to-show', () => {
    widgetWindow.show();
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

  widgetWindow.on('closed', () => { widgetWindow = null; });
}

/**
 * Меню виджета — нативное: HTML-меню обрезалось бы границами окна 360×100.
 * Координаты приходят из рендерера в пикселях относительно окна.
 */
function showWidgetMenu(x, y) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Открыть Яндекс Музыку', click: showMainWindow },
    { label: 'Скачать текущий трек', click: () => downloadCurrentTrack() },
    { label: 'Настройки загрузок', click: () => { showMainWindow(); playerCall('openSettings'); } },
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
      x: Math.max(0, bounds.x - display.bounds.x + WIDGET_PAD),
      y: Math.max(0, bounds.y - display.bounds.y + WIDGET_PAD),
      width: Math.max(1, bounds.width - WIDGET_PAD * 2),
      height: Math.max(1, bounds.height - WIDGET_PAD * 2),
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
    { label: 'Открыть Яндекс Музыку', click: showMainWindow },
    { label: 'Показать виджет', click: () => showWidget() },
    { label: 'Вернуть виджет на место', click: () => handleWidgetCommand('reset-position') },
    {
      label: 'Виджет включён',
      type: 'checkbox',
      checked: Boolean(widgetWindow && !widgetWindow.isDestroyed()),
      click: toggleWidget,
    },
    { label: 'Скачать текущий трек', click: () => downloadCurrentTrack() },
    { label: 'Настройки загрузок', click: () => { showMainWindow(); playerCall('openSettings'); } },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ];
}

function trayTooltip() {
  return lastState && lastState.title
    ? `${lastState.artist} — ${lastState.title}`
    : 'YaMusic Widget';
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

async function createTray() {
  const image = nativeImage.createFromPath(ICON_PATH).resize({ width: 32, height: 32 });

  // Сначала пробуем собственный StatusNotifierItem: в GNOME он рисуется
  // корректно, в отличие от встроенного Tray
  const started = await traySni.start({
    id: 'ya-music-widget',
    title: 'YaMusic Widget',
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
async function downloadCurrentTrack() {
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

  ipcMain.on('player:state', (_event, state) => {
    const trackChanged = !lastState || lastState.title !== state.title
      || lastState.artist !== state.artist;
    const pausedChanged = !lastState || lastState.paused !== state.paused;
    lastState = state;
    sendToWidget('player:state', state);
    mpris.update(state);
    if (trackChanged || pausedChanged) rebuildTrayMenu();
  });

  ipcMain.on('player:log', (_event, message) => console.log('[page]', message));

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
    glass: config.get('widget_glass'),
    glassOptions: config.get('glass_options'),
    glassBackdrop: config.get('glass_backdrop'),
    glassImage: config.get('glass_backdrop_image') || wallpaperPath,
    systemGlass: ['darwin', 'win32'].includes(process.platform),
    wallpaper: wallpaperPath,
    opacity: config.get('widget_opacity'),
    authorized: config.isAuthorized(),
  };
}

/** Применяет настройки, влияющие на уже созданные окна. */
function applyRuntimeSettings() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.setOpacity(config.get('widget_opacity'));
    widgetWindow.setAlwaysOnTop(config.get('widget_always_on_top'), 'screen-saver');
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

  // Блокировка рекламных запросов
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (config.get('block_ads') && isAdUrl(details.url)) {
      callback({ cancel: true });
      return;
    }
    callback({});
  });

  // Убираем из User-Agent следы Electron — сайт должен видеть обычный Chrome
  app.userAgentFallback = app.userAgentFallback
    .replace(/\s?(YaMusic Widget|Electron)\/[\d.]+/g, '');
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
  dialog.showErrorBox('YaMusic Widget', message);
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
    config.initSecureStorage();
    api = new YmApi(() => config.getToken());
    downloader = new Downloader(api, config);
    downloader.setProgressCallback(reportProgress);

    setupSession();
    registerIpc();
    wallpaper.find().then((found) => {
      wallpaperPath = found;
      if (found) {
        console.log('[main] обои для стекла: %s', found);
        sendToWidget('widget:config', widgetConfig());
        sendWidgetGeometry();
      }
    });
    createMainWindow();
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
