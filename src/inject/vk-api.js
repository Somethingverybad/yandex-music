/**
 * Доступ к аудио ВК из страницы vk.ru — то, что нужно загрузчику.
 *
 * Исполняется в главном мире окна ВК, поэтому запросы уходят с cookie
 * активной сессии и правильным Origin: отдельная авторизация приложению
 * не нужна, достаточно того, что пользователь вошёл в окне ВК.
 *
 * Протокол (endpoint al_audio.php, формат кортежа аудиозаписи, порядок
 * распаковки ссылки) разобран по VK Audiopad — https://github.com/vissh/vkui-audiopad,
 * MIT, © 2023 Denis Matveev. Реализация ниже своя.
 *
 * Важное ограничение: al_audio.php — внутренний эндпоинт сайта, а не
 * документированное API. Формат ответа может измениться в любой момент,
 * тогда перестанет работать скачивание (воспроизведение — нет, за него
 * отвечает сам веб-плеер ВК).
 */
(function () {
  if (window.__vkApi) return 'already';

  // Индексы полей в кортеже аудиозаписи — их порядок задаёт сам VK
  var FIELD = {
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

  /* ---------- распаковка ссылки на файл ---------- */

  /*
   * Ссылку на mp3 VK отдаёт замаскированной: вместо адреса приходит строка
   * с меткой audio_api_unavailable, где в «?extra=<данные>#<операции>»
   * лежит закодированный адрес и список преобразований над ним.
   * Операции применяются с конца; ключом к части из них служит id
   * текущего пользователя.
   */

  // Алфавит VK: обычный base64, но 0 и O переставлены местами
  var ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0PQRSTUVWXYZO123456789+/=';

  /** base64 в алфавите VK; для битой строки возвращает null. */
  function decodeBase64(text) {
    if (!text || text.length % 4 === 1) return null;
    var result = '';
    var bits = 0;
    var count = 0;
    for (var i = 0; i < text.length; i++) {
      var index = ALPHABET.indexOf(text.charAt(i));
      if (index < 0) continue;
      bits = count % 4 ? bits * 64 + index : index;
      if (count++ % 4) {
        result += String.fromCharCode(255 & (bits >> ((-2 * count) & 6)));
      }
    }
    return result;
  }

  /**
   * Последовательность позиций для перестановки символов: зависит только
   * от длины строки и ключа, поэтому обратима на стороне VK.
   */
  function permutation(length, key) {
    var positions = [];
    if (!length) return positions;
    var seed = Math.abs(key);
    for (var i = length - 1; i >= 0; i--) {
      seed = (length * (i + 1) ^ (seed + i)) % length;
      positions[i] = seed;
    }
    return positions;
  }

  var OPS = {
    /** развернуть строку */
    v: function (text) {
      return text.split('').reverse().join('');
    },

    /** сдвинуть каждый символ по алфавиту на shift позиций назад */
    r: function (text, shift) {
      var doubled = ALPHABET + ALPHABET;
      var chars = text.split('');
      for (var i = chars.length - 1; i >= 0; i--) {
        var index = doubled.indexOf(chars[i]);
        if (index >= 0) chars[i] = doubled.substr(index - Number(shift), 1);
      }
      return chars.join('');
    },

    /** переставить символы по позициям из permutation() */
    s: function (text, key) {
      var length = text.length;
      if (!length) return text;
      var positions = permutation(length, Number(key));
      var chars = text.split('');
      for (var i = 1; i < length; i++) {
        chars[i] = chars.splice(positions[length - 1 - i], 1, chars[i])[0];
      }
      return chars.join('');
    },

    /** то же, но ключ смешан с id пользователя */
    i: function (text, key, userId) {
      return OPS.s(text, Number(key) ^ Number(userId));
    },

    /** XOR каждого символа с первым символом ключа */
    x: function (text, key) {
      var code = String(key).charCodeAt(0);
      var out = '';
      for (var i = 0; i < text.length; i++) {
        out += String.fromCharCode(text.charCodeAt(i) ^ code);
      }
      return out;
    },
  };

  // Разделители списка операций и их аргументов внутри блока
  var OP_SEPARATOR = String.fromCharCode(9);
  var ARG_SEPARATOR = String.fromCharCode(11);

  /**
   * Возвращает прямой адрес файла. Немаскированную ссылку отдаёт как есть,
   * при непонятной последовательности операций — тоже: пусть лучше не
   * скачается, чем скачается битый файл.
   */
  function unmaskUrl(url, userId) {
    if (!url || url.indexOf('audio_api_unavailable') < 0) return url;

    var parts = url.split('?extra=')[1];
    if (!parts) return url;

    var blocks = parts.split('#');
    var value = decodeBase64(blocks[0]);
    var script = blocks[1] === '' ? '' : decodeBase64(blocks[1]);
    if (typeof script !== 'string' || !value) return url;

    var operations = script ? script.split(OP_SEPARATOR) : [];
    for (var i = operations.length - 1; i >= 0; i--) {
      var args = operations[i].split(ARG_SEPARATOR);
      var name = args.shift();
      if (!OPS[name]) return url;
      value = OPS[name].apply(null, [value].concat(args, [userId]));
    }

    return value && value.substr(0, 4) === 'http' ? value : url;
  }

  /* ---------- запросы к странице ---------- */

  /** id вошедшего пользователя — ключ распаковки ссылок. */
  function currentUserId() {
    if (window.vk && window.vk.id) return String(window.vk.id);
    var link = document.querySelector('a[href^="/id"]');
    var match = link && link.getAttribute('href').match(/^\/id(\d+)/);
    return match ? match[1] : '0';
  }

  /** Ответ al_audio.php приходит в windows-1251 и с полезной нагрузкой в payload. */
  function alAudio(act, params) {
    var body = new FormData();
    body.set('act', act);
    body.set('al', '1');
    Object.keys(params || {}).forEach(function (key) { body.set(key, params[key]); });

    return fetch('https://vk.ru/al_audio.php?act=' + encodeURIComponent(act), {
      method: 'POST',
      body: body,
      credentials: 'include',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    })
      .then(function (response) { return response.arrayBuffer(); })
      .then(function (buffer) {
        var text = new TextDecoder('windows-1251').decode(buffer);
        return JSON.parse(text);
      });
  }

  /** Кортеж текущего трека: сначала из плеера, затем из разметки. */
  function currentTuple() {
    var ap = window.ap;
    if (ap && typeof ap.getCurrentAudio === 'function') {
      try {
        var tuple = ap.getCurrentAudio();
        if (tuple && tuple.length > FIELD.ID) return tuple;
      } catch (err) { /* ниже — по DOM */ }
    }
    var el = document.querySelector('.top_audio_player[data-audio], .audio_row_playing[data-audio]');
    if (!el) return null;
    try {
      return JSON.parse(el.getAttribute('data-audio'));
    } catch (err) {
      return null;
    }
  }

  function describe(tuple) {
    if (!tuple) return null;
    var cover = String(tuple[FIELD.COVER_URL] || '').split(',')[0];
    return {
      id: String(tuple[FIELD.OWNER_ID]) + '_' + String(tuple[FIELD.ID]),
      accessKey: String(tuple[FIELD.ACCESS_KEY] || ''),
      title: decodeEntities(String(tuple[FIELD.TITLE] || '')),
      artist: decodeEntities(String(tuple[FIELD.PERFORMER] || '')),
      album: decodeEntities(String((tuple[FIELD.ALBUM] && tuple[FIELD.ALBUM][1]) || '')),
      duration: Number(tuple[FIELD.DURATION]) || 0,
      cover: cover || '',
      url: String(tuple[FIELD.URL] || ''),
    };
  }

  /** В названиях приходят HTML-сущности вроде &amp; */
  function decodeEntities(text) {
    if (text.indexOf('&') < 0) return text;
    var area = document.createElement('textarea');
    area.innerHTML = text;
    return area.value;
  }

  window.__vkApi = {
    /**
     * Всё, что нужно для скачивания текущего трека: метаданные и прямая
     * ссылка на файл. Ссылка из плеера часто уже протухла, поэтому
     * запрашиваем свежую через reload_audios.
     */
    currentTrack: function () {
      var track = describe(currentTuple());
      if (!track) return Promise.resolve(null);

      var userId = currentUserId();
      var ids = track.accessKey ? track.id + '_' + track.accessKey : track.id;

      return alAudio('reload_audios', { audio_ids: ids })
        .then(function (response) {
          var list = response && response.payload && response.payload[1]
            && response.payload[1][0];
          var fresh = describe(list && list[0]);
          if (fresh && fresh.url) {
            fresh.url = unmaskUrl(fresh.url, userId);
            return fresh;
          }
          track.url = unmaskUrl(track.url, userId);
          return track;
        })
        .catch(function () {
          track.url = unmaskUrl(track.url, userId);
          return track;
        });
    },
  };

  return 'ok';
})();
