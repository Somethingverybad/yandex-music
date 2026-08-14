/**
 * Перехват выбора музыки в окне ВК.
 *
 * В режиме собственного плеера страница нужна только как каталог: человек
 * ищет и выбирает музыку привычным интерфейсом, но звук идёт не отсюда.
 * Скрипт глушит воспроизведение сайтом и отдаёт в приложение очередь —
 * дальше играет окно-движок (renderer/player.js).
 *
 * Опираемся на window.ap, плеер самой страницы: в нынешней вёрстке ВК у
 * строк списка нет ни data-audio, ни data-full-id, зато текущий трек и
 * очередь лежат в нём.
 */
(function () {
  if (window.__vkPicker) return 'already';
  window.__vkPicker = true;

  // Поля кортежа аудиозаписи — порядок задаёт сам VK
  var FIELD = {
    ID: 0, OWNER_ID: 1, TITLE: 3, PERFORMER: 4, DURATION: 5,
    COVER_URL: 14, ACCESS_KEY: 24,
  };

  /* ---------- сайт больше не играет ---------- */

  /*
   * Оригинальный play() не вызываем вовсе: иначе трек зазвучал бы дважды —
   * из страницы и из нашего движка. Обещание возвращаем выполненным, чтобы
   * интерфейс ВК не считал запуск неудачным и не показывал ошибку.
   */
  var origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    try {
      this.muted = true;
      origPlay.call(this).then(function () {}, function () {}); // прогреваем и глушим
      this.pause();
    } catch (err) { /* элемент мог быть ещё не готов */ }
    return Promise.resolve();
  };

  /* ---------- чтение очереди ---------- */

  function decodeEntities(text) {
    if (text.indexOf('&') < 0) return text;
    var area = document.createElement('textarea');
    area.innerHTML = text;
    return area.value;
  }

  function toTrack(tuple) {
    if (!tuple || !tuple.length) return null;
    return {
      id: String(tuple[FIELD.OWNER_ID]) + '_' + String(tuple[FIELD.ID]),
      accessKey: String(tuple[FIELD.ACCESS_KEY] || ''),
      title: decodeEntities(String(tuple[FIELD.TITLE] || '')),
      artist: decodeEntities(String(tuple[FIELD.PERFORMER] || '')),
      duration: Number(tuple[FIELD.DURATION]) || 0,
      cover: String(tuple[FIELD.COVER_URL] || '').split(',')[0] || '',
    };
  }

  function currentTuple() {
    var ap = window.ap;
    if (!ap || typeof ap.getCurrentAudio !== 'function') return null;
    try {
      return ap.getCurrentAudio() || null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Очередь текущего раздела.
   *
   * Плеер ВК хранит её в нескольких местах, и наполняются они не
   * одновременно: сразу после клика getPlaylist() ещё пуст, а очередь
   * воспроизведения в getCurrentPlaylist() уже готова — на ней всё и
   * держится. Остальные источники оставлены на случай, если ВК опять
   * переставит поля; берём самый длинный вариант.
   */
  function currentQueue() {
    var ap = window.ap;
    if (!ap) return [];

    var candidates = [];
    var add = function (value) {
      if (Array.isArray(value) && value.length) candidates.push(value);
    };

    try { add(ap.getPlaylist && ap.getPlaylist()._list); } catch (err) { /* дальше */ }
    try { add(ap.getCurrentPlaylist && ap.getCurrentPlaylist()._list); } catch (err) { /* дальше */ }
    try { add(ap._currentPlaylist && ap._currentPlaylist._list); } catch (err) { /* дальше */ }
    try { add(ap._playlistQueue); } catch (err) { /* дальше */ }

    var best = [];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].length > best.length) best = candidates[i];
    }
    return best;
  }

  /* ---------- отправка выбора ---------- */

  var lastSent = '';

  function pick() {
    var tuple = currentTuple();
    if (!tuple) return;

    var track = toTrack(tuple);
    if (!track || track.id === lastSent) return;
    lastSent = track.id;

    var tracks = currentQueue().map(toTrack).filter(Boolean);
    var index = -1;
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].id === track.id) { index = i; break; }
    }
    // раздел ещё не подгрузился — играем хотя бы выбранное
    if (index < 0) {
      tracks = [track];
      index = 0;
    }

    if (window.__ymHost && window.__ymHost.pick) {
      window.__ymHost.pick({ tracks: tracks, index: index });
    }
  }

  // Смену трека ловим опросом: у ap своя шина событий, но её имена
  // меняются вместе с вёрсткой, а поле с текущим треком живёт давно
  setInterval(pick, 400);

  return 'ok';
})();
