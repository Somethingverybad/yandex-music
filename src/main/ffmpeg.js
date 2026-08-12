'use strict';
/**
 * Сборка трека из HLS-потока.
 *
 * ВК отдаёт музыку плейлистом m3u8: десятки сегментов, иногда зашифрованных.
 * Собирать их вручную нет смысла — этим занимается ffmpeg, который лежит
 * рядом с приложением (пакет ffmpeg-static) либо берётся из системы.
 *
 * Сначала пробуем скопировать поток как есть: у ВК внутри обычно уже mp3,
 * и тогда файл получается без перекодирования и потери качества. Если внутри
 * другой кодек (AAC), ffmpeg на этом падает — тогда перекодируем в mp3
 * с битрейтом из настроек.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Путь к бинарнику. Внутри собранного приложения ресурсы лежат в архиве
 * app.asar, откуда исполнять файл нельзя, — electron-builder распаковывает
 * их рядом (asarUnpack в package.json), туда и смотрим.
 */
function binaryPath() {
  // Свой бинарник в assets/bin — так собирается universal-сборка под macOS:
  // ffmpeg-static кладёт файл только под текущую архитектуру, а тут лежит
  // склеенный через lipo arm64 + x86_64 (см. README, раздел про сборку).
  const bundled = path.join(__dirname, '..', '..', 'assets', 'bin',
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const bundledUnpacked = bundled.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  if (fs.existsSync(bundledUnpacked)) return bundledUnpacked;
  if (fs.existsSync(bundled)) return bundled;

  let packaged = null;
  try {
    packaged = require('ffmpeg-static');
  } catch (err) {
    packaged = null;
  }
  if (packaged) {
    const unpacked = packaged.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    if (fs.existsSync(unpacked)) return unpacked;
    if (fs.existsSync(packaged)) return packaged;
  }
  // Запасной вариант — системный ffmpeg
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

function isAvailable() {
  const binary = binaryPath();
  return path.isAbsolute(binary) ? fs.existsSync(binary) : true;
}

/** «time=00:01:23.45» из вывода ffmpeg — по нему считаем проценты. */
function parseProgressSeconds(chunk) {
  const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(chunk);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function run(args, { onProgress, duration } = {}) {
  return new Promise((resolve, reject) => {
    // без shell: в путях бывают пробелы, а на Windows это ещё и опасно
    const child = spawn(binaryPath(), args, { windowsHide: true });
    let errorTail = '';

    child.stderr.on('data', (data) => {
      const chunk = String(data);
      errorTail = (errorTail + chunk).slice(-2000);
      if (!onProgress || !duration) return;
      const seconds = parseProgressSeconds(chunk);
      if (seconds != null) {
        onProgress(Math.max(0, Math.min(99, Math.round((seconds / duration) * 100))));
      }
    });

    child.on('error', (err) => reject(new Error('ffmpeg не запустился: ' + err.message)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(errorTail.trim().split('\n').pop() || `ffmpeg завершился с кодом ${code}`));
    });
  });
}

/**
 * Скачивает поток и сохраняет его в mp3.
 *
 * @param {string} url        ссылка на m3u8
 * @param {string} outPath    куда положить файл
 * @param {object} options    userAgent, referer, bitrate, duration, onProgress
 */
async function hlsToMp3(url, outPath, options = {}) {
  const {
    userAgent = '', referer = '', bitrate = 320, duration = 0, onProgress = null,
  } = options;

  const input = [
    '-hide_banner', '-loglevel', 'error', '-stats',
    // без постоянного соединения: сегменты ВК раздаёт по одному
    '-http_persistent', '0',
  ];
  if (userAgent) input.push('-user_agent', userAgent);
  if (referer) input.push('-headers', `Referer: ${referer}\r\n`);
  input.push('-i', url, '-vn', '-map', 'a:0');

  const copyArgs = [...input, '-c:a', 'copy', '-f', 'mp3', '-y', outPath];
  try {
    await run(copyArgs, { onProgress, duration });
    return { path: outPath, recoded: false };
  } catch (err) {
    console.log('[ffmpeg] поток не mp3 (%s) — перекодирую', err.message);
  }

  const encodeArgs = [...input, '-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-y', outPath];
  await run(encodeArgs, { onProgress, duration });
  return { path: outPath, recoded: true };
}

module.exports = { hlsToMp3, isAvailable, binaryPath };
