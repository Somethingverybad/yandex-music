'use strict';
/**
 * Клиент аудио ВК для main-процесса — работает без страницы сервиса.
 *
 * Запросы идут через net.fetch, то есть сетевым стеком Chromium и с cookie
 * той же сессии, в которой пользователь вошёл в окне ВК. Благодаря этому
 * страницу можно открывать только ради входа, а дальше держать в памяти
 * лёгкий плеер вместо полноценного сайта.
 *
 * Протокол (endpoint al_audio.php, формат кортежа аудиозаписи, порядок
 * распаковки ссылки) разобран по VK Audiopad — https://github.com/vissh/vkui-audiopad,
 * MIT, © 2023 Denis Matveev. Реализация своя.
 *
 * Ограничение то же, что и раньше: al_audio.php — внутренний эндпоинт сайта,
 * а не документированное API, и его формат может измениться в любой момент.
 */
const { net } = require('electron');

const BASE = 'https://vk.ru';

// Индексы полей в кортеже аудиозаписи — порядок задаёт сам VK
const FIELD = {
  ID: 0,
  OWNER_ID: 1,
  URL: 2,
  TITLE: 3,
  PERFORMER: 4,
  DURATION: 5,
  COVER_URL: 14,
  ALBUM: 19,
  ACCESS_KEY: 24,
};

/* ------------------------------------------------------------------ */
/* Распаковка ссылки на файл                                           */
/* ------------------------------------------------------------------ */

/*
 * Вместо адреса ВК отдаёт строку с меткой audio_api_unavailable, где
 * в «?extra=<данные>#<операции>» лежат закодированный адрес и список
 * преобразований над ним. Операции применяются с конца, ключом к части
 * из них служит id текущего пользователя.
 */

// Алфавит VK: обычный base64, но 0 и O переставлены местами
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0PQRSTUVWXYZO123456789+/=';

function decodeBase64(text) {
  if (!text || text.length % 4 === 1) return null;
  let result = '';
  let bits = 0;
  let count = 0;
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) continue;
    bits = count % 4 ? bits * 64 + index : index;
    if (count++ % 4) {
      result += String.fromCharCode(255 & (bits >> ((-2 * count) & 6)));
    }
  }
  return result;
}

/** Позиции перестановки: зависят только от длины строки и ключа. */
function permutation(length, key) {
  const positions = [];
  if (!length) return positions;
  let seed = Math.abs(key);
  for (let i = length - 1; i >= 0; i--) {
    seed = ((length * (i + 1)) ^ (seed + i)) % length;
    positions[i] = seed;
  }
  return positions;
}

const OPS = {
  /** развернуть строку */
  v: (text) => text.split('').reverse().join(''),

  /** сдвинуть каждый символ по алфавиту назад */
  r: (text, shift) => {
    const doubled = ALPHABET + ALPHABET;
    const chars = text.split('');
    for (let i = chars.length - 1; i >= 0; i--) {
      const index = doubled.indexOf(chars[i]);
      if (index >= 0) chars[i] = doubled.substr(index - Number(shift), 1);
    }
    return chars.join('');
  },

  /** переставить символы по позициям из permutation() */
  s: (text, key) => {
    const length = text.length;
    if (!length) return text;
    const positions = permutation(length, Number(key));
    const chars = text.split('');
    for (let i = 1; i < length; i++) {
      chars[i] = chars.splice(positions[length - 1 - i], 1, chars[i])[0];
    }
    return chars.join('');
  },

  /** то же, но ключ смешан с id пользователя */
  i: (text, key, userId) => OPS.s(text, Number(key) ^ Number(userId)),

  /** XOR каждого символа с первым символом ключа */
  x: (text, key) => {
    const code = String(key).charCodeAt(0);
    let out = '';
    for (const char of text) out += String.fromCharCode(char.charCodeAt(0) ^ code);
    return out;
  },
};

const OP_SEPARATOR = String.fromCharCode(9);
const ARG_SEPARATOR = String.fromCharCode(11);

/**
 * Прямой адрес файла. Немаскированную ссылку возвращает как есть, при
 * непонятной последовательности операций — тоже: лучше не скачать, чем
 * получить битый файл.
 */
function unmaskUrl(url, userId) {
  if (!url || !url.includes('audio_api_unavailable')) return url;

  const tail = url.split('?extra=')[1];
  if (!tail) return url;

  const [dataPart, scriptPart] = tail.split('#');
  let value = decodeBase64(dataPart);
  const script = scriptPart === '' ? '' : decodeBase64(scriptPart);
  if (typeof script !== 'string' || !value) return url;

  const operations = script ? script.split(OP_SEPARATOR) : [];
  for (let i = operations.length - 1; i >= 0; i--) {
    const args = operations[i].split(ARG_SEPARATOR);
    const name = args.shift();
    if (!OPS[name]) return url;
    value = OPS[name](value, ...args, userId);
  }

  return value && value.slice(0, 4) === 'http' ? value : url;
}

/* ------------------------------------------------------------------ */
/* Запросы                                                             */
/* ------------------------------------------------------------------ */

/** Ответ приходит в windows-1251, полезная нагрузка — в payload. */
async function call(act, params = {}) {
  const body = new URLSearchParams({ act, al: '1', ...params });

  const response = await net.fetch(`${BASE}/al_audio.php?act=${encodeURIComponent(act)}`, {
    method: 'POST',
    body,
    credentials: 'include',
    headers: {
      'x-requested-with': 'XMLHttpRequest',
      'content-type': 'application/x-www-form-urlencoded',
    },
  });

  if (!response.ok) throw new Error(`ВК ответил ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const text = new TextDecoder('windows-1251').decode(buffer);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('ВК вернул не JSON — возможно, сессия истекла');
  }
}

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/** Кортеж аудиозаписи — во внутреннее представление. */
function toTrack(tuple, userId) {
  if (!Array.isArray(tuple) || tuple.length <= FIELD.ID) return null;
  return {
    id: `${tuple[FIELD.OWNER_ID]}_${tuple[FIELD.ID]}`,
    accessKey: String(tuple[FIELD.ACCESS_KEY] || ''),
    title: decodeEntities(String(tuple[FIELD.TITLE] || '')),
    artist: decodeEntities(String(tuple[FIELD.PERFORMER] || '')),
    duration: Number(tuple[FIELD.DURATION]) || 0,
    cover: String(tuple[FIELD.COVER_URL] || '').split(',')[0] || '',
    url: unmaskUrl(String(tuple[FIELD.URL] || ''), userId),
  };
}

/**
 * Свежие данные треков по их идентификаторам.
 *
 * @param {string[]} ids  «ownerId_audioId» либо «ownerId_audioId_accessKey»
 * @param {string} userId id пользователя — ключ распаковки ссылок
 */
async function tracks(ids, userId) {
  if (!ids.length) return [];
  const data = await call('reload_audios', { audio_ids: ids.join(',') });
  const list = data && data.payload && data.payload[1] && data.payload[1][0];
  if (!Array.isArray(list)) return [];
  return list.map((tuple) => toTrack(tuple, userId)).filter(Boolean);
}

/** Один трек со свежей ссылкой на файл. */
async function track(id, accessKey, userId) {
  const key = accessKey ? `${id}_${accessKey}` : id;
  const [found] = await tracks([key], userId);
  return found || null;
}

module.exports = { call, track, tracks, unmaskUrl, toTrack, FIELD };
