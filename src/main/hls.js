'use strict';
/**
 * Сборка HLS-потока в один файл.
 *
 * Почему не отдать плейлист прямо ffmpeg: ВК шифрует только первый сегмент
 * (`#EXT-X-KEY:METHOD=AES-128`), а дальше в том же плейлисте объявляет
 * `METHOD=NONE`. На такой смене ключа статическая сборка ffmpeg падает с
 * SIGSEGV — процесс умирает молча, без единой строки в stderr. Поэтому
 * сегменты скачиваем и расшифровываем сами, а ffmpeg получает уже готовый
 * локальный файл и занимается только распаковкой аудио из контейнера.
 */
const fs = require('fs');
const crypto = require('crypto');

async function fetchBuffer(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`${response.status} при загрузке ${new URL(url).pathname.split('/').pop()}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Разбирает строку #EXT-X-KEY; для METHOD=NONE возвращает null. */
function parseKey(line, playlistUrl) {
  const method = /METHOD=([A-Z0-9-]+)/.exec(line);
  if (!method || method[1] === 'NONE') return null;
  if (method[1] !== 'AES-128') {
    throw new Error('Неподдерживаемое шифрование потока: ' + method[1]);
  }
  const uri = /URI="([^"]+)"/.exec(line);
  if (!uri) throw new Error('В плейлисте нет ссылки на ключ шифрования');
  const iv = /IV=0x([\da-f]+)/i.exec(line);
  return {
    uri: new URL(uri[1], playlistUrl).toString(),
    iv: iv ? Buffer.from(iv[1], 'hex') : null,
  };
}

/**
 * Ключ действует до следующего #EXT-X-KEY, поэтому разбираем плейлист
 * построчно, запоминая текущий ключ и номер сегмента.
 */
function parsePlaylist(text, playlistUrl) {
  const segments = [];
  let key = null;
  let sequence = 0;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      sequence = parseInt(line.split(':')[1], 10) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-KEY')) {
      key = parseKey(line, playlistUrl);
      continue;
    }
    if (line.startsWith('#')) continue;

    segments.push({
      url: new URL(line, playlistUrl).toString(),
      key,
      sequence: sequence + segments.length,
    });
  }
  return segments;
}

/** Когда IV не задан явно, им служит номер сегмента (RFC 8216, 5.2). */
function sequenceIv(sequence) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(sequence >>> 0, 12);
  return iv;
}

function decryptSegment(data, key, iv) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch (err) {
    // Некоторые сегменты приходят без PKCS7-хвоста — снимаем padding сами
    const raw = crypto.createDecipheriv('aes-128-cbc', key, iv);
    raw.setAutoPadding(false);
    return Buffer.concat([raw.update(data), raw.final()]);
  }
}

/**
 * Скачивает плейлист целиком в один файл.
 *
 * @param {string} playlistUrl ссылка на m3u8
 * @param {string} outPath     куда писать склеенный поток
 * @param {object} options     headers, onProgress(pct)
 * @returns {Promise<{path: string, segments: number}>}
 */
async function download(playlistUrl, outPath, { headers = {}, onProgress = null } = {}) {
  const text = (await fetchBuffer(playlistUrl, headers)).toString('utf8');
  if (!text.trimStart().startsWith('#EXTM3U')) {
    throw new Error('По ссылке не HLS-плейлист');
  }

  const segments = parsePlaylist(text, playlistUrl);
  if (!segments.length) throw new Error('В плейлисте нет сегментов');

  const keys = new Map();
  const out = fs.createWriteStream(outPath);

  try {
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      let data = await fetchBuffer(segment.url, headers);

      if (segment.key) {
        if (!keys.has(segment.key.uri)) {
          keys.set(segment.key.uri, await fetchBuffer(segment.key.uri, headers));
        }
        data = decryptSegment(data, keys.get(segment.key.uri),
          segment.key.iv || sequenceIv(segment.sequence));
      }

      await new Promise((resolve, reject) => {
        out.write(data, (err) => (err ? reject(err) : resolve()));
      });
      if (onProgress) onProgress(Math.round(((i + 1) / segments.length) * 100));
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }

  return { path: outPath, segments: segments.length };
}

module.exports = { download, parsePlaylist };
