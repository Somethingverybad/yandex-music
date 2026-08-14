'use strict';
/**
 * Настройки приложения и хранение OAuth-токена.
 *
 * Настройки — JSON в каталоге профиля Electron (app.getPath('userData')):
 *   Linux   ~/.config/TheIf/settings.json
 *   Windows %APPDATA%\TheIf\settings.json
 *   macOS   ~/Library/Application Support/TheIf/settings.json
 *
 * Токен шифруется через safeStorage (на Linux — gnome-libsecret/kwallet,
 * на Windows — DPAPI, на macOS — Keychain) и лежит рядом в token.bin.
 * В логи токен не попадает никогда.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

// Структуры каталогов загрузки (совместимы со старым Python-клиентом)
const LAYOUTS = ['flat', 'artist', 'album', 'artist_album'];

const DEFAULTS = {
  download_path: path.join(os.homedir(), 'Music', 'YaMusic Desktop'),
  download_layout: 'artist',
  // Предпочитаемый битрейт mp3: берём максимум из доступных, но не выше этого
  preferred_bitrate: 320,
  // Не перекачивать уже существующие файлы
  skip_existing: true,
  // Блокировщик рекламы в окне Яндекс Музыки
  block_ads: true,
  // Активный источник музыки: 'ym' — Яндекс Музыка, 'vk' — ВК Музыка.
  // Виджет управляет тем сервисом, который выбран здесь.
  source: 'ym',
  // Держать окно ВК Музыки: выключенный источник не создаёт окна и не
  // ходит в сеть вовсе
  vk_enabled: true,
  // Собственный плеер для ВК: страница открывается только ради входа и
  // выбора музыки, звук идёт из окна-движка. Полноценный сайт в памяти
  // весит около 300 МБ, движок — около 120 МБ.
  vk_native_player: true,
  // id вошедшего пользователя ВК: служит ключом распаковки ссылок на файлы.
  // Читается из страницы при входе и сохраняется, чтобы дальше обходиться
  // без неё — см. vk-api.js
  vk_user_id: null,
  // Виджет
  widget_enabled: true,
  widget_x: null,
  widget_y: null,
  widget_compact: false,
  widget_always_on_top: true,
  widget_opacity: 1,
  // Цвет акцента виджета для каждого сервиса: по нему видно, чем сейчас
  // управляет виджет, отдельной подписи нет
  widget_accent_ym: '#ffdb4d',
  widget_accent_vk: '#4aa1ff',
  // Показывать виджет в панели задач: свёрнутый виджет возвращается
  // кликом по его иконке, а не только через трей
  widget_in_taskbar: true,
  // Стеклянный вид виджета. На macOS и Windows включается системное
  // размытие фона за окном (vibrancy / acrylic), на Linux стекло
  // строится поверх размытой обложки трека
  widget_glass: true,
  // Что преломляет стекло:
  //   'artwork'  — обложка текущего трека, меняется вместе с ним (по умолчанию);
  //   'image'    — своя картинка из glass_backdrop_image (например, обои);
  //   'snapshot' — снимок экрана под виджетом; в Wayland требует разрешения
  //                через xdg-desktop-portal, поэтому только по команде.
  glass_backdrop: 'artwork',
  glass_backdrop_image: null,
  // Тонкая настройка стекла: показатель преломления, сила смещения,
  // хроматическая аберрация, матовость, тонировка, кромка и блик
  glass_options: {
    ior: 1.45,
    displacement: 58,
    chroma: 0.16,
    thickness: 26,
    blurStrength: 0.86,
    tint: 0.16,
    rimIntensity: 0.34,
    specular: 0.6,
  },
  // Только macOS: материал системного размытия под виджетом. Чем «легче»
  // материал, тем прозрачнее стекло: 'hud' и 'popover' почти не затемняют,
  // 'under-window' и 'sheet' — самые плотные. Полный список значений —
  // в документации BrowserWindow.vibrancy.
  mac_vibrancy: 'hud',
  // Стартовать со скрытым большим окном (виджет + трей)
  start_hidden: true,
  // Графический бэкенд на Linux: x11 (через XWayland — работает везде),
  // wayland (нативно) или auto. На части систем нативный Wayland-бэкенд
  // Chromium падает при создании окна, поэтому по умолчанию x11.
  ozone_platform: 'x11',
  // Хранилище системных ключей на Linux для safeStorage: gnome-libsecret,
  // kwallet, kwallet5, kwallet6, basic или auto. Указываем явно —
  // при автоопределении Chromium может выбрать разные бэкенды в разных
  // сеансах, и сохранённый токен перестаёт расшифровываться.
  password_store: 'gnome-libsecret',
  // Закрытие большого окна прячет его, а не выходит из приложения
  close_to_tray: true,
};

let dataDir = null;
let settingsPath = null;
let tokenPath = null;
let keyPath = null;
let probePath = null;
let data = { ...DEFAULTS };
let tokenReadWarned = false;

function init() {
  dataDir = app.getPath('userData');
  settingsPath = path.join(dataDir, 'settings.json');
  tokenPath = path.join(dataDir, 'token.bin');
  keyPath = path.join(dataDir, 'key.bin');
  probePath = path.join(dataDir, 'probe.bin');
  load();
}

function load() {
  try {
    if (fs.existsSync(settingsPath)) {
      const loaded = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (loaded && typeof loaded === 'object') {
        for (const key of Object.keys(DEFAULTS)) {
          if (key in loaded) data[key] = loaded[key];
        }
      }
    }
  } catch (err) {
    console.warn('[config] не удалось прочитать настройки:', err.message);
  }
  if (!LAYOUTS.includes(data.download_layout)) {
    data.download_layout = DEFAULTS.download_layout;
  }
  if (!data.download_path) data.download_path = DEFAULTS.download_path;
}

function save() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[config] не удалось сохранить настройки:', err.message);
    throw new Error('Не удалось сохранить настройки');
  }
}

function get(key) {
  return data[key];
}

function set(key, value) {
  if (!(key in DEFAULTS)) return;
  data[key] = value;
}

/** Применяет объект настроек с валидацией; возвращает актуальный снимок. */
function update(patch) {
  patch = patch || {};
  if (patch.download_path !== undefined) {
    const value = String(patch.download_path).trim();
    if (!value) throw new Error('Путь не может быть пустым');
    data.download_path = value;
  }
  if (patch.download_layout !== undefined) {
    if (!LAYOUTS.includes(patch.download_layout)) {
      throw new Error('Недопустимая структура каталогов: ' + patch.download_layout);
    }
    data.download_layout = patch.download_layout;
  }
  if (patch.ozone_platform !== undefined) {
    const platform = String(patch.ozone_platform);
    if (['x11', 'wayland', 'auto'].includes(platform)) data.ozone_platform = platform;
  }
  if (patch.password_store !== undefined) {
    const store = String(patch.password_store);
    if (['gnome-libsecret', 'kwallet', 'kwallet5', 'kwallet6', 'basic', 'auto'].includes(store)) {
      data.password_store = store;
    }
  }
  if (patch.preferred_bitrate !== undefined) {
    const bitrate = parseInt(patch.preferred_bitrate, 10);
    data.preferred_bitrate = [64, 128, 192, 320].includes(bitrate) ? bitrate : 320;
  }
  for (const key of ['skip_existing', 'block_ads', 'widget_enabled', 'widget_compact',
    'widget_always_on_top', 'widget_in_taskbar', 'widget_glass', 'vk_enabled', 'vk_native_player',
    'start_hidden', 'close_to_tray']) {
    if (patch[key] !== undefined) data[key] = Boolean(patch[key]);
  }
  for (const key of ['widget_x', 'widget_y']) {
    if (patch[key] !== undefined) data[key] = patch[key] === null ? null : Math.round(patch[key]);
  }
  for (const key of ['widget_accent_ym', 'widget_accent_vk']) {
    if (patch[key] === undefined) continue;
    const color = String(patch[key]).trim();
    // только #rrggbb: цвет уходит в стили виджета
    if (/^#[\da-f]{6}$/i.test(color)) data[key] = color.toLowerCase();
  }
  if (patch.vk_user_id !== undefined) {
    const value = String(patch.vk_user_id || '').trim();
    data.vk_user_id = /^\d+$/.test(value) ? value : null;
  }
  if (patch.source !== undefined) {
    const source = String(patch.source);
    if (['ym', 'vk'].includes(source)) data.source = source;
  }
  if (patch.mac_vibrancy !== undefined) {
    const value = patch.mac_vibrancy;
    data.mac_vibrancy = value ? String(value) : null;
  }
  if (patch.glass_backdrop !== undefined) {
    const mode = String(patch.glass_backdrop);
    if (['artwork', 'image', 'snapshot'].includes(mode)) data.glass_backdrop = mode;
  }
  if (patch.glass_backdrop_image !== undefined) {
    const value = patch.glass_backdrop_image;
    data.glass_backdrop_image = value ? String(value) : null;
  }
  if (patch.glass_options !== undefined && typeof patch.glass_options === 'object') {
    const allowed = Object.keys(DEFAULTS.glass_options);
    const next = { ...data.glass_options };
    for (const key of allowed) {
      const value = Number(patch.glass_options[key]);
      if (Number.isFinite(value)) next[key] = value;
    }
    data.glass_options = next;
  }
  if (patch.widget_opacity !== undefined) {
    const value = Number(patch.widget_opacity);
    data.widget_opacity = Number.isFinite(value) ? Math.min(1, Math.max(0.3, value)) : 1;
  }
  save();
  return asDict();
}

/** Снимок настроек для отправки в UI (ключи совместимы с inject.js). */
function asDict() {
  return { ...data, layouts: [...LAYOUTS] };
}

/* ---------- токен ---------- */

/*
 * Токен лежит в token.bin: первый байт — формат шифрования,
 * дальше полезная нагрузка.
 *   1 — safeStorage (системное хранилище ключей ОС);
 *   2 — AES-256-GCM с локальным ключом key.bin (права 0600);
 *   0 — base64 (только как аварийный вариант).
 *
 * Системное хранилище надёжно не везде: в частности, если сеанс GNOME не
 * разблокировал login keyring, Chromium каждый запуск генерирует новый
 * ключ, и вчерашний токен уже не расшифровать. Поэтому при старте мы
 * проверяем сохранность контрольной записи probe.bin и, если она не
 * читается, переключаемся на локальный ключ.
 */
const PROBE_TEXT = 'ya-music-widget-probe';
let storageMode = 'local';

function initSecureStorage() {
  storageMode = 'local';
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    if (fs.existsSync(probePath)) {
      try {
        if (safeStorage.decryptString(fs.readFileSync(probePath)) === PROBE_TEXT) {
          storageMode = 'system';
          return;
        }
      } catch (_) { /* контрольная запись не читается — системное ненадёжно */ }
    }
    // Записываем контрольный образец: следующий запуск проверит,
    // пережил ли он перезапуск.
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(probePath, safeStorage.encryptString(PROBE_TEXT), { mode: 0o600 });
  } catch (err) {
    console.warn('[config] проверка системного хранилища не удалась:', err.message);
  } finally {
    console.log('[config] хранилище токена: %s', storageMode === 'system'
      ? 'системное (safeStorage)'
      : 'локальный ключ AES-256-GCM');
  }
}

function localKey() {
  try {
    const existing = fs.readFileSync(keyPath);
    if (existing.length === 32) return existing;
  } catch (_) { /* создадим новый */ }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

function localEncrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', localKey(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

function localDecrypt(buffer) {
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', localKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
}

function getToken() {
  try {
    if (!fs.existsSync(tokenPath)) return null;
    const raw = fs.readFileSync(tokenPath);
    const format = raw[0];
    const payload = raw.subarray(1);
    let token;
    if (format === 1) token = safeStorage.decryptString(payload);
    else if (format === 2) token = localDecrypt(payload);
    else token = Buffer.from(payload.toString('utf8'), 'base64').toString('utf8');
    return token.trim() || null;
  } catch (err) {
    if (!tokenReadWarned) {
      tokenReadWarned = true;
      console.error('[config] не удалось прочитать токен (введите его заново):', err.message);
    }
    return null;
  }
}

function saveToken(token) {
  if (!token || !String(token).trim()) throw new Error('Токен не может быть пустым');
  token = String(token).trim();
  fs.mkdirSync(dataDir, { recursive: true });

  let buffer;
  try {
    buffer = storageMode === 'system'
      ? Buffer.concat([Buffer.from([1]), safeStorage.encryptString(token)])
      : Buffer.concat([Buffer.from([2]), localEncrypt(token)]);
  } catch (err) {
    console.warn('[config] шифрование не удалось (%s), пробую локальный ключ', err.message);
    buffer = Buffer.concat([Buffer.from([2]), localEncrypt(token)]);
  }

  fs.writeFileSync(tokenPath, buffer, { mode: 0o600 });
  tokenReadWarned = false;
  console.log('[config] токен сохранён (длина %d)', token.length);
}

function deleteToken() {
  try {
    fs.unlinkSync(tokenPath);
  } catch (_) {
    /* нет файла — ок */
  }
}

function isAuthorized() {
  return Boolean(getToken());
}

module.exports = {
  LAYOUTS, DEFAULTS,
  init, initSecureStorage, load, save, get, set, update, asDict,
  getToken, saveToken, deleteToken, isAuthorized,
};
