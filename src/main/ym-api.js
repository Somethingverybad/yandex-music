'use strict';
/**
 * Минимальный клиент API Яндекс Музыки на Node (замена Python-библиотеки
 * `yandex-music` из исходного проекта).
 *
 * Реализовано ровно то, что нужно приложению:
 *   - проверка токена / текущий аккаунт;
 *   - треки, альбом с треками, плейлист (по owner:kind и по uuid);
 *   - получение прямой ссылки на mp3 (download-info + подпись).
 *
 * Подпись ссылки — классический алгоритм мобильного клиента:
 *   GET /tracks/<id>/download-info      -> список вариантов (codec/bitrate/downloadInfoUrl)
 *   GET <downloadInfoUrl>               -> XML {host, path, ts, s}
 *   sign = md5(SALT + path.slice(1) + s)
 *   file = https://<host>/get-mp3/<sign>/<ts><path>
 */
const crypto = require('crypto');

const API_BASE = 'https://api.music.yandex.net';
const MD5_SALT = 'XGRlBW9FXlekgbPrRHuSiA';

const DEFAULT_HEADERS = {
  'X-Yandex-Music-Client': 'YandexMusicAndroid/24023621',
  'User-Agent': 'Yandex-Music-API',
  Accept: 'application/json',
};

class YmApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'YmApiError';
    this.status = status;
  }
}

class YmApi {
  /**
   * @param {() => (string|null)} tokenGetter — источник актуального токена
   */
  constructor(tokenGetter) {
    this._tokenGetter = tokenGetter;
  }

  _token() {
    const token = this._tokenGetter();
    if (!token) throw new YmApiError('Токен не найден. Введите его в настройках.', 401);
    return token;
  }

  async _request(path, { query, method = 'GET', body, raw = false } = {}) {
    const url = new URL(API_BASE + path);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const init = {
      method,
      headers: { ...DEFAULT_HEADERS, Authorization: `OAuth ${this._token()}` },
    };
    if (body) {
      init.body = new URLSearchParams(body).toString();
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const response = await fetch(url, init);
    if (!response.ok) {
      let detail = '';
      try {
        const json = await response.json();
        detail = (json && json.error && (json.error.message || json.error.name)) || '';
      } catch (_) { /* тело не JSON */ }
      throw new YmApiError(
        `API вернула ${response.status}${detail ? ': ' + detail : ''}`, response.status);
    }
    if (raw) return response;
    const json = await response.json();
    return json && 'result' in json ? json.result : json;
  }

  /* ---------- аккаунт ---------- */

  async accountStatus() {
    return this._request('/account/status');
  }

  async validateToken() {
    try {
      const status = await this.accountStatus();
      return Boolean(status && status.account);
    } catch (err) {
      console.warn('[ym-api] проверка токена не пройдена:', err.message);
      return false;
    }
  }

  async myUid() {
    const status = await this.accountStatus();
    return status && status.account ? status.account.uid : null;
  }

  /* ---------- контент ---------- */

  async tracks(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).map(String);
    return this._request('/tracks', { method: 'POST', body: { 'track-ids': list.join(',') } });
  }

  async track(id) {
    const found = await this.tracks([id]);
    if (!found || !found.length) throw new YmApiError(`Трек ${id} не найден`, 404);
    return found[0];
  }

  async albumWithTracks(albumId) {
    return this._request(`/albums/${encodeURIComponent(albumId)}/with-tracks`);
  }

  async userPlaylist(uid, kind) {
    return this._request(`/users/${encodeURIComponent(uid)}/playlists/${encodeURIComponent(kind)}`);
  }

  async playlistByUuid(uuid) {
    // Редакционные плейлисты имеют ссылку /playlists/<uuid>; из ответа
    // достаём owner uid + kind и добираем полный объект с треками.
    const short = await this._request(`/playlist/${encodeURIComponent(uuid)}`);
    if (short && short.uid !== undefined && short.kind !== undefined) {
      return this.userPlaylist(short.uid, short.kind);
    }
    return short;
  }

  /**
   * Плейлист по идентификатору из ссылки: "<uid>:<kind>" либо uuid.
   */
  async playlist(playlistId) {
    const id = String(playlistId);
    if (id.includes(':')) {
      const [uid, kind] = id.split(':');
      try {
        return await this.userPlaylist(uid, kind);
      } catch (err) {
        if (err.status !== 404) throw err;
        // Иногда ЯМ отдаёт чужой uid для собственного плейлиста — пробуем свой
        const myUid = await this.myUid();
        if (myUid && String(myUid) !== String(uid)) {
          return this.userPlaylist(myUid, kind);
        }
        throw new YmApiError(`Плейлист ${id} не найден`, 404);
      }
    }
    return this.playlistByUuid(id);
  }

  /** Треки плейлиста в виде полных объектов (короткие записи дозагружаются). */
  async playlistTracks(playlist) {
    const items = playlist && playlist.tracks ? playlist.tracks : [];
    const full = [];
    const missing = [];
    for (const item of items) {
      if (item && item.track) full.push(item.track);
      else if (item && item.id) missing.push(String(item.id));
    }
    if (missing.length) {
      // Догружаем пачками по 100 идентификаторов
      for (let i = 0; i < missing.length; i += 100) {
        const chunk = await this.tracks(missing.slice(i, i + 100));
        full.push(...(chunk || []));
      }
    }
    return full;
  }

  /** Поиск трека — фолбэк, когда id текущего трека не удалось вытащить из плеера. */
  async searchTrack(text) {
    const found = await this._request('/search', {
      query: { text, type: 'track', page: 0, 'nocorrect': false },
    });
    const results = found && found.tracks && found.tracks.results;
    return results && results.length ? results[0] : null;
  }

  /* ---------- прямая ссылка на файл ---------- */

  async downloadInfo(trackId) {
    return this._request(`/tracks/${encodeURIComponent(trackId)}/download-info`);
  }

  /**
   * Выбирает лучший mp3-вариант не выше заданного битрейта.
   * Если таких нет — берёт наименьший доступный.
   */
  static pickVariant(variants, preferredBitrate = 320) {
    const mp3 = (variants || []).filter((v) => v && v.codec === 'mp3' && v.downloadInfoUrl);
    if (!mp3.length) return null;
    mp3.sort((a, b) => (b.bitrateInKbps || 0) - (a.bitrateInKbps || 0));
    return mp3.find((v) => (v.bitrateInKbps || 0) <= preferredBitrate) || mp3[mp3.length - 1];
  }

  /** Превращает downloadInfoUrl в прямую ссылку на mp3. */
  async directLink(variant) {
    const response = await fetch(variant.downloadInfoUrl, { headers: DEFAULT_HEADERS });
    if (!response.ok) {
      throw new YmApiError(`Не удалось получить ссылку на файл (${response.status})`, response.status);
    }
    const text = await response.text();
    const info = parseDownloadInfo(text);
    if (!info) throw new YmApiError('Не удалось разобрать ответ download-info');

    const sign = crypto.createHash('md5')
      .update(MD5_SALT + info.path.slice(1) + info.s)
      .digest('hex');
    return `https://${info.host}/get-mp3/${sign}/${info.ts}${info.path}`;
  }

  /** Прямая ссылка на mp3 по id трека. */
  async trackFileUrl(trackId, preferredBitrate = 320) {
    const variants = await this.downloadInfo(trackId);
    const variant = YmApi.pickVariant(variants, preferredBitrate);
    if (!variant) throw new YmApiError('Для трека нет доступных mp3-вариантов (возможно, недоступен в регионе)');
    const url = await this.directLink(variant);
    return { url, bitrate: variant.bitrateInKbps || 0 };
  }
}

/** Разбирает ответ download-info: XML (по умолчанию) либо JSON. */
function parseDownloadInfo(text) {
  const trimmed = (text || '').trim();
  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed);
      const src = json['download-info'] || json;
      if (src && src.host && src.path && src.ts && src.s) {
        return { host: src.host, path: src.path, ts: src.ts, s: src.s };
      }
    } catch (_) { /* попробуем как XML */ }
  }
  const pick = (tag) => {
    const match = trimmed.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return match ? match[1] : null;
  };
  const host = pick('host');
  const filePath = pick('path');
  const ts = pick('ts');
  const s = pick('s');
  if (host && filePath && ts && s) return { host, path: filePath, ts, s };
  return null;
}

module.exports = { YmApi, YmApiError, MD5_SALT, parseDownloadInfo };
