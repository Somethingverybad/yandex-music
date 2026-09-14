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
    // В очереди страницы лежат и ещё не подгруженные записи: id есть,
    // названия и исполнителя нет. Играть такое нечем — пропускаем.
    if (!tuple[FIELD.TITLE] && !tuple[FIELD.PERFORMER]) return null;
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
   * Плейлисты, которые знает плеер ВК.
   *
   * Он хранит их в нескольких местах, и наполняются они не одновременно:
   * сразу после клика getPlaylist() ещё пуст, а очередь воспроизведения
   * в getCurrentPlaylist() уже готова. Первым идёт именно играющий
   * плейлист — остальные на случай, если ВК опять переставит поля.
   */
  function playlists() {
    var ap = window.ap;
    if (!ap) return [];

    var found = [];
    var add = function (value) {
      if (value && Array.isArray(value._list) && value._list.length && found.indexOf(value) < 0) {
        found.push(value);
      }
    };

    try { add(ap.getCurrentPlaylist && ap.getCurrentPlaylist()); } catch (err) { /* дальше */ }
    try { add(ap._currentPlaylist); } catch (err) { /* дальше */ }
    try { add(ap.getPlaylist && ap.getPlaylist()); } catch (err) { /* дальше */ }
    // Очередь воспроизведения: в новой вёрстке ВК именно здесь лежит выдача
    // поиска, тогда как «текущий плейлист» остаётся пустым. Это объект со
    // списком внутри, хотя раньше бывал и простым массивом.
    try { add(ap.getPlaylistQueue && ap.getPlaylistQueue()); } catch (err) { /* дальше */ }
    try {
      if (Array.isArray(ap._playlistQueue)) found.push({ _list: ap._playlistQueue });
      else add(ap._playlistQueue);
    } catch (err) { /* дальше */ }
    return found;
  }

  /**
   * Отпечаток плейлиста: тип и id раздела — «Моя музыка», поиск, альбом.
   * По нему приложение отличает клик внутри того же списка от перехода в
   * другой раздел. Если у ВК этих полей не окажется, вернётся пустая
   * строка, и приложение сравнит списки по содержимому.
   */
  function playlistKey(playlist) {
    if (!playlist) return '';
    var read = function (getter, field) {
      try {
        if (typeof playlist[getter] === 'function') {
          var value = playlist[getter]();
          if (value !== undefined && value !== null) return String(value);
        }
      } catch (err) { /* поле ниже */ }
      var raw = playlist[field];
      return raw === undefined || raw === null ? '' : String(raw);
    };
    var type = read('getType', '_type');
    var owner = read('getOwnerId', '_ownerId');
    var id = read('getId', '_id');
    if (!type && !id) return '';
    return 'vk:' + type + ':' + owner + '_' + id;
  }

  /**
   * Очередь раздела, в котором играет трек.
   *
   * Раньше брался самый длинный список из всех, что знает плеер, и им
   * почти всегда оказывалась «Моя музыка»: включённый из поиска трек
   * попадал в неё, и после него продолжалась библиотека, а не выдача.
   * Теперь предпочитаем играющий плейлист, если трек в нём есть, а к
   * самому длинному списку возвращаемся только когда трека нет нигде.
   */
  function currentQueue(trackId) {
    var all = playlists();
    var best = null;
    var longest = null;
    for (var i = 0; i < all.length; i++) {
      var list = all[i]._list;
      if (!longest || list.length > longest._list.length) longest = all[i];
      if (best || !trackId) continue;
      for (var j = 0; j < list.length; j++) {
        var tuple = list[j];
        if (tuple && String(tuple[FIELD.OWNER_ID]) + '_' + String(tuple[FIELD.ID]) === trackId) {
          best = all[i];
          break;
        }
      }
    }
    var playlist = best || longest;
    if (!playlist) return { tracks: [], key: '' };
    // У очереди воспроизведения нет ни типа, ни id — раздел, откуда она
    // взялась, знает текущий плейлист (пусть даже его список пуст)
    var key = playlistKey(playlist);
    if (!key) {
      try { key = playlistKey(window.ap.getCurrentPlaylist()); } catch (err) { /* нет ключа */ }
    }
    return {
      tracks: playlist._list.map(toTrack).filter(Boolean),
      key: key,
    };
  }

  /* ---------- отправка выбора ---------- */

  var lastSent = '';
  var lastQueueKey = '';   // чтобы не слать одну и ту же очередь по кругу
  var lastPlaying = null;  // играла ли страница при прошлом опросе
  // Сколько ждать, пока страница наполнит список вокруг выбранного трека:
  // сразу после клика он пуст, и одиночный трек ушёл бы раньше времени
  var LIST_WAIT_MS = 3000;
  var waitingFor = '';
  var waitingSince = 0;

  /** Играет ли плеер страницы; null, если у ap нет такого признака. */
  function pagePlaying() {
    var ap = window.ap;
    if (!ap || typeof ap.isPlaying !== 'function') return null;
    try {
      return Boolean(ap.isPlaying());
    } catch (err) {
      return null;
    }
  }

  /** Отпечаток очереди: длина и края — этого хватает, чтобы заметить правку. */
  function queueKey(tracks) {
    if (!tracks.length) return '';
    return tracks.length + ':' + tracks[0].id + ':' + tracks[tracks.length - 1].id;
  }

  function pick() {
    var tuple = currentTuple();
    if (!tuple) return;

    var track = toTrack(tuple);
    if (!track) return;

    var playing = pagePlaying();
    // Тот же трек, что и раньше, — выбором считается только запуск с паузы:
    // так ловится клик по песне, которую страница показывала после загрузки
    if (track.id === lastSent) {
      var resumed = playing === true && lastPlaying === false;
      lastPlaying = playing;
      if (!resumed) return;
    }
    lastPlaying = playing;

    /*
     * После загрузки страница показывает последний слушанный трек, хотя не
     * играет его. Раньше он уходил в приложение как выбор и подменял
     * очередь — стоило открыть окно ВК, чтобы, например, войти заново.
     * Запоминаем его молча: выбором станет следующая смена трека.
     */
    if (!lastSent && playing === false) {
      lastSent = track.id;
      return;
    }
    var queue = currentQueue(track.id);
    var tracks = queue.tracks;
    var index = -1;
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].id === track.id) { index = i; break; }
    }
    if (index < 0) {
      // раздел ещё не подгрузился — даём ему несколько секунд, и только
      // потом играем хотя бы выбранное
      if (waitingFor !== track.id) {
        waitingFor = track.id;
        waitingSince = Date.now();
      }
      if (Date.now() - waitingSince < LIST_WAIT_MS) return;
      tracks = [track];
      index = 0;
    }
    waitingFor = '';
    lastSent = track.id;

    lastQueueKey = queueKey(tracks);
    if (window.__ymHost && window.__ymHost.pick) {
      window.__ymHost.pick({ tracks: tracks, index: index, playlist: queue.key });
    }
  }

  /*
   * Пересылает список раздела целиком.
   *
   * Только что добавленный трек ВК запускает как плейлист из него одного,
   * и приложению дальше идти некуда. Полный список страница знает, поэтому
   * время от времени присылаем его заново — приложение подставит очередь
   * вокруг играющей песни, не прерывая её.
   */
  function syncQueue() {
    if (!window.__ymHost || !window.__ymHost.syncQueue) return;
    var queue = currentQueue(lastSent);
    var tracks = queue.tracks;
    if (tracks.length < 2) return;

    // без отпечатка каждые десять секунд уезжал бы один и тот же список
    var key = queueKey(tracks);
    if (key === lastQueueKey) return;
    lastQueueKey = key;

    window.__ymHost.syncQueue({ tracks: tracks, playlist: queue.key });
  }

  // Смену трека ловим опросом: у ap своя шина событий, но её имена
  // меняются вместе с вёрсткой, а поле с текущим треком живёт давно
  setInterval(pick, 400);
  setInterval(syncQueue, 10000);

  /*
   * Весь перехват держится на window.ap. Если ВК его переименует или отдаст
   * другой плеер, выбор молча перестанет доходить до приложения, поэтому
   * сообщаем о пропаже сразу — иначе искать причину не по чему.
   */
  setTimeout(function () {
    if (!window.__ymHost || !window.__ymHost.log) return;
    var ap = window.ap;
    window.__ymHost.log('picker: ap=' + Boolean(ap)
      + ', getCurrentAudio=' + Boolean(ap && ap.getCurrentAudio)
      + ', getCurrentPlaylist=' + Boolean(ap && ap.getCurrentPlaylist));
  }, 3000);

  return 'ok';
})();
