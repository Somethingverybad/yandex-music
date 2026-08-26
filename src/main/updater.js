'use strict';
/**
 * Обновления через GitHub Releases.
 *
 * Пока приложение подписано ad-hoc, встроенный установщик macOS его не
 * примет: подпись проверяет система, а не приложение. Поэтому модуль
 * работает на два режима и сам выбирает подходящий.
 *
 *   - есть подпись Developer ID: electron-updater скачивает и ставит сам;
 *   - подписи нет: спрашиваем у GitHub последний релиз и показываем
 *     уведомление со ссылкой — обновиться придётся вручную.
 *
 * Второй режим — не запасной костыль, а рабочее состояние до получения
 * сертификата, поэтому он должен вести себя внятно, а не молча падать.
 */
const { app, net, Notification, shell } = require('electron');

const REPO = 'Somethingverybad/yandex-music';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

// Первую проверку откладываем: при старте приложению есть чем заняться
const FIRST_CHECK_DELAY = 30 * 1000;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

let timer = null;
let notified = '';     // о какой версии уже сказали, чтобы не повторяться

/** «1.2.10» новее «1.2.9»: сравниваем числами, а не строками. */
function isNewer(candidate, current) {
  const parse = (value) => String(value).replace(/^v/, '').split('.').map((part) => parseInt(part, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left !== right) return left > right;
  }
  return false;
}

function announce(version, { manual = false } = {}) {
  if (!manual && notified === version) return;
  notified = version;

  if (!Notification.isSupported()) {
    console.log('[updater] доступна версия %s: %s', version, RELEASES_PAGE);
    return;
  }

  const notice = new Notification({
    title: `Доступна версия ${version}`,
    body: 'Нажмите, чтобы открыть страницу загрузки',
  });
  notice.on('click', () => shell.openExternal(RELEASES_PAGE).catch(() => {}));
  notice.show();
}

/** Последний релиз по данным GitHub — без установщика, только версия. */
async function latestRelease() {
  const response = await net.fetch(API_LATEST, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`GitHub ответил ${response.status}`);
  const data = await response.json();
  return String(data.tag_name || data.name || '').replace(/^v/, '');
}

/** Ручной режим: сообщаем о новой версии и оставляем установку человеку. */
async function checkManually({ manual = false } = {}) {
  try {
    const version = await latestRelease();
    if (!version) return null;

    if (isNewer(version, app.getVersion())) {
      console.log('[updater] доступна версия %s (сейчас %s)', version, app.getVersion());
      announce(version, { manual });
      return version;
    }

    console.log('[updater] установлена последняя версия (%s)', app.getVersion());
    if (manual && Notification.isSupported()) {
      new Notification({
        title: 'Обновлений нет',
        body: `Установлена последняя версия — ${app.getVersion()}`,
      }).show();
    }
    return null;
  } catch (err) {
    console.warn('[updater] проверка не удалась: %s', err.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Встроенный установщик                                               */
/* ------------------------------------------------------------------ */

let autoUpdater = null;
let autoBroken = false;   // установщик отказал — дальше только ручной режим

function setupAutoUpdater() {
  if (autoUpdater || autoBroken) return autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.warn('[updater] electron-updater недоступен: %s', err.message);
    autoBroken = true;
    return null;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] найдено обновление %s, качаю', info && info.version);
  });

  autoUpdater.on('update-downloaded', (info) => {
    const version = (info && info.version) || '';
    console.log('[updater] обновление %s скачано, встанет при выходе', version);
    if (!Notification.isSupported()) return;
    const notice = new Notification({
      title: `Обновление ${version} готово`,
      body: 'Оно установится при следующем запуске приложения',
    });
    notice.show();
  });

  autoUpdater.on('error', (err) => {
    const message = (err && err.message) || String(err);
    // На неподписанной сборке установщик отказывается работать — это
    // ожидаемо, поэтому переходим в ручной режим без лишнего шума
    console.warn('[updater] встроенный установщик недоступен: %s', message);
    autoBroken = true;
    checkManually();
  });

  return autoUpdater;
}

/* ------------------------------------------------------------------ */
/* Публичное                                                           */
/* ------------------------------------------------------------------ */

async function check({ manual = false } = {}) {
  // из исходников обновляться нечему
  if (!app.isPackaged) {
    console.log('[updater] запуск из исходников — проверка пропущена');
    if (manual) await checkManually({ manual });
    return;
  }

  if (autoBroken) {
    await checkManually({ manual });
    return;
  }

  const updater = setupAutoUpdater();
  if (!updater) {
    await checkManually({ manual });
    return;
  }

  try {
    await updater.checkForUpdates();
  } catch (err) {
    console.warn('[updater] проверка не удалась: %s', err.message);
    autoBroken = true;
    await checkManually({ manual });
  }
}

function start(enabled) {
  stop();
  if (!enabled) {
    console.log('[updater] проверка обновлений выключена в настройках');
    return;
  }
  setTimeout(() => check(), FIRST_CHECK_DELAY);
  timer = setInterval(() => check(), CHECK_INTERVAL);
}

function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, check, openReleases: () => shell.openExternal(RELEASES_PAGE) };
