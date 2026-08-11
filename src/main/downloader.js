'use strict';
/**
 * Скачивание треков, альбомов и плейлистов Яндекс Музыки.
 * Порт core/downloader.py исходного проекта на Node.
 *
 * Структура каталогов (настройка download_layout):
 *   flat          — все треки в одном каталоге;
 *   artist        — <base>/<Исполнитель>/<Трек>.mp3;
 *   album         — <base>/<Альбом>/<Трек>.mp3;
 *   artist_album  — <base>/<Исполнитель>/<Альбом>/<Трек>.mp3.
 *
 * ID3-теги (название, исполнитель, альбом, номер, год) и обложка
 * встраиваются через node-id3.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const NodeID3 = require('node-id3');

const { YmApi } = require('./ym-api');

const MAX_PART_LEN = 64;

/** Убирает запрещённые в именах файлов символы и обрезает длину. */
function sanitize(text) {
  let value = String(text == null ? '' : text)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  value = value.slice(0, MAX_PART_LEN).trim();
  return value || 'unknown';
}

function formatArtists(artists) {
  const names = (artists || []).map((a) => a && a.name).filter(Boolean);
  return names.length ? names.join(', ') : 'Unknown Artist';
}

function trackAlbum(track) {
  const albums = (track && track.albums) || [];
  return albums.length ? albums[0] : null;
}

/** Ссылка на обложку нужного размера из cover_uri вида "avatars.../%%". */
function coverUrl(entity, size = '400x400') {
  const uri = entity && (entity.coverUri || entity.cover_uri
    || (entity.cover && entity.cover.uri));
  if (!uri) return null;
  return 'https://' + String(uri).replace('%%', size);
}

async function fetchCover(track, album) {
  const url = coverUrl(track) || coverUrl(album) || coverUrl(trackAlbum(track));
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    console.warn('[downloader] не удалось скачать обложку:', err.message);
    return null;
  }
}

class Downloader {
  /**
   * @param {YmApi} api
   * @param {object} config — модуль config (get/asDict)
   */
  constructor(api, config) {
    this._api = api;
    this._config = config;
    this._onProgress = null;
    this._cancelled = new Set();
  }

  /** callback({ jobId, current, total, pct, title, phase }) */
  setProgressCallback(callback) {
    this._onProgress = callback;
  }

  _progress(payload) {
    try {
      if (this._onProgress) this._onProgress(payload);
    } catch (_) { /* прогресс не должен ломать скачивание */ }
  }

  cancel(jobId) {
    if (jobId) this._cancelled.add(String(jobId));
  }

  _isCancelled(jobId) {
    return jobId != null && this._cancelled.has(String(jobId));
  }

  /* ---------- пути ---------- */

  _baseDir() {
    return this._config.get('download_path');
  }

  _trackDir(base, track, album) {
    const layout = this._config.get('download_layout');
    const artist = sanitize(formatArtists(track.artists));
    const albumObj = album || trackAlbum(track);
    const albumTitle = sanitize((albumObj && albumObj.title) || 'Без альбома');

    switch (layout) {
      case 'artist': return path.join(base, artist);
      case 'album': return path.join(base, albumTitle);
      case 'artist_album': return path.join(base, artist, albumTitle);
      default: return base;
    }
  }

  /* ---------- один трек ---------- */

  async _saveTrack(track, baseDir, { number = null, album = null } = {}) {
    const directory = this._trackDir(baseDir, track, album);
    await fsp.mkdir(directory, { recursive: true });

    const title = sanitize(track.title || 'track');
    const artist = sanitize(formatArtists(track.artists));
    const prefix = number != null ? String(number).padStart(2, '0') + ' - ' : '';
    const filePath = path.join(directory, `${prefix}${artist} - ${title}.mp3`);

    if (this._config.get('skip_existing') && fs.existsSync(filePath)) {
      const stat = await fsp.stat(filePath);
      if (stat.size > 0) {
        console.log('[downloader] пропуск (уже скачан): %s', path.basename(filePath));
        return { path: filePath, skipped: true };
      }
    }

    const trackId = String(track.id ?? track.trackId ?? '');
    const { url } = await this._api.trackFileUrl(trackId, this._config.get('preferred_bitrate'));

    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Не удалось скачать файл (${response.status})`);
    }
    const tmpPath = filePath + '.part';
    try {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmpPath));
      await fsp.rename(tmpPath, filePath);
    } catch (err) {
      await fsp.unlink(tmpPath).catch(() => {});
      throw err;
    }

    await this._writeTags(filePath, track, album);
    console.log('[downloader] скачан трек: %s', path.basename(filePath));
    return { path: filePath, skipped: false };
  }

  async _writeTags(filePath, track, album) {
    try {
      const albumObj = album || trackAlbum(track);
      const tags = {
        title: track.title || 'Unknown',
        artist: formatArtists(track.artists),
      };
      if (albumObj) {
        if (albumObj.title) tags.album = albumObj.title;
        if (albumObj.year) tags.year = String(albumObj.year);
        if (albumObj.genre) tags.genre = albumObj.genre;
      }
      // Номер трека лежит в albums[].trackPosition самого трека
      const inAlbum = trackAlbum(track);
      const position = track.trackPosition || (inAlbum && inAlbum.trackPosition);
      if (position && position.index) tags.trackNumber = String(position.index);

      const cover = await fetchCover(track, albumObj);
      if (cover) {
        tags.image = {
          mime: 'image/jpeg',
          type: { id: 3, name: 'front cover' },
          description: 'Cover',
          imageBuffer: cover,
        };
      }
      const result = NodeID3.write(tags, filePath);
      if (result !== true && result instanceof Error) throw result;
    } catch (err) {
      // Теги не должны ломать скачивание
      console.warn('[downloader] не удалось проставить теги для %s: %s',
        path.basename(filePath), err.message);
    }
  }

  /* ---------- публичный API ---------- */

  async downloadTrack(trackId, { jobId } = {}) {
    const track = await this._api.track(trackId);
    const base = this._baseDir();
    await fsp.mkdir(base, { recursive: true });
    this._progress({ jobId, current: 0, total: 1, pct: 0, title: track.title });
    const saved = await this._saveTrack(track, base);
    this._progress({ jobId, current: 1, total: 1, pct: 100, title: track.title });
    return {
      ok: true,
      saved: 1,
      skipped: saved.skipped ? 1 : 0,
      path: saved.path,
      title: `${formatArtists(track.artists)} — ${track.title}`,
    };
  }

  async downloadAlbum(albumId, { jobId } = {}) {
    const album = await this._api.albumWithTracks(albumId);
    if (!album) throw new Error(`Альбом ${albumId} не найден`);

    const base = this._baseDir();
    const tracks = [];
    for (const volume of album.volumes || []) {
      for (const track of volume || []) tracks.push(track);
    }
    console.log('[downloader] альбом «%s»: %d трек(ов)', album.title, tracks.length);

    return this._downloadMany(tracks, base, { jobId, album, title: album.title });
  }

  async downloadPlaylist(playlistId, { jobId } = {}) {
    const playlist = await this._api.playlist(playlistId);
    if (!playlist) throw new Error(`Плейлист ${playlistId} не найден`);

    const tracks = await this._api.playlistTracks(playlist);
    let base = this._baseDir();
    // При «плоской» раскладке складываем плейлист в отдельную папку,
    // иначе треки свалятся в общую кучу.
    if (this._config.get('download_layout') === 'flat') {
      base = path.join(base, sanitize(playlist.title || 'playlist'));
    }
    console.log('[downloader] плейлист «%s»: %d трек(ов)', playlist.title, tracks.length);

    return this._downloadMany(tracks, base, { jobId, title: playlist.title });
  }

  async _downloadMany(tracks, base, { jobId, album = null, title = '' } = {}) {
    await fsp.mkdir(base, { recursive: true });
    const total = tracks.length;
    let saved = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 0; i < total; i += 1) {
      if (this._isCancelled(jobId)) {
        this._cancelled.delete(String(jobId));
        break;
      }
      const track = tracks[i];
      try {
        const result = await this._saveTrack(track, base, { number: i + 1, album });
        if (result.skipped) skipped += 1;
        else saved += 1;
      } catch (err) {
        console.error('[downloader] ошибка трека «%s»: %s', track && track.title, err.message);
        errors.push(`${(track && track.title) || 'трек'}: ${err.message}`);
      }
      this._progress({
        jobId,
        current: i + 1,
        total,
        pct: total ? Math.round(((i + 1) * 100) / total) : 100,
        title: (track && track.title) || '',
        collection: title,
      });
    }

    return { ok: saved + skipped > 0, saved, skipped, errors, path: base, title };
  }

  /** Точка входа из UI: track / album / playlist. */
  async downloadItem(itemId, itemType, options = {}) {
    const type = String(itemType || '').toLowerCase();
    if (type === 'track') return this.downloadTrack(String(itemId), options);
    if (type === 'album') return this.downloadAlbum(String(itemId), options);
    if (type === 'playlist') return this.downloadPlaylist(String(itemId), options);
    throw new Error(`Неизвестный тип объекта: ${itemType}`);
  }
}

module.exports = { Downloader, sanitize, formatArtists, coverUrl };
