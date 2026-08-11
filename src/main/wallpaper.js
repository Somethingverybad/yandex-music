'use strict';
/**
 * Путь к обоям рабочего стола.
 *
 * Нужен виджету, чтобы стекло преломляло реальный фон под окном: содержимое
 * экрана за пределами своего окна рендереру недоступно, но обои — обычный
 * файл, и, зная позицию окна, можно подложить ровно тот их участок,
 * который находится под виджетом.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

/** GNOME хранит обои в gsettings, отдельно для светлой и тёмной темы. */
async function fromGnome() {
  const scheme = await run('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme']);
  const dark = scheme ? scheme.includes('dark') : false;
  const keys = dark ? ['picture-uri-dark', 'picture-uri'] : ['picture-uri', 'picture-uri-dark'];

  for (const key of keys) {
    const value = await run('gsettings', ['get', 'org.gnome.desktop.background', key]);
    if (!value) continue;
    const uri = value.replace(/^'|'$/g, '');
    if (!uri || uri === 'none') continue;
    const filePath = uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri;
    if (!fs.existsSync(filePath)) continue;
    // GNOME умеет ставить фоном XML-слайдшоу — достаём из него картинку
    if (filePath.endsWith('.xml')) {
      const picture = fromSlideshow(filePath);
      if (picture) return picture;
      continue;
    }
    return filePath;
  }
  return null;
}

/** Из XML-слайдшоу берём первый существующий кадр. */
function fromSlideshow(xmlPath) {
  try {
    const text = fs.readFileSync(xmlPath, 'utf8');
    const matches = text.match(/<(?:file|from)>([^<]+)<\/(?:file|from)>/g) || [];
    for (const entry of matches) {
      const file = entry.replace(/<[^>]+>/g, '').trim();
      if (file && fs.existsSync(file)) return file;
    }
  } catch (_) { /* не читается — не беда */ }
  return null;
}

/** KDE Plasma: путь лежит в конфиге плазмы. */
function fromPlasma() {
  const configPath = path.join(os.homedir(), '.config', 'plasma-org.kde.plasma.desktop-appletsrc');
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    const match = text.match(/^Image=(.+)$/m);
    if (!match) return null;
    const value = match[1].trim().replace(/^file:\/\//, '');
    return fs.existsSync(value) ? value : null;
  } catch (_) {
    return null;
  }
}

/**
 * @returns {Promise<string|null>} абсолютный путь к файлу обоев
 */
async function find() {
  if (process.platform !== 'linux') return null;
  try {
    const desktop = String(process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
    if (desktop.includes('kde') || desktop.includes('plasma')) {
      return fromPlasma() || (await fromGnome());
    }
    return (await fromGnome()) || fromPlasma();
  } catch (err) {
    console.warn('[wallpaper] не удалось определить обои:', err.message);
    return null;
  }
}

module.exports = { find };
