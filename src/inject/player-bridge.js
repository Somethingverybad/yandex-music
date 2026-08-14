/**
 * Драйвер веб-плеера. Один и тот же скрипт работает и в окне Яндекс Музыки,
 * и в окне ВК Музыки: общая часть опирается на mediaSession и медиа-элементы,
 * а всё, что зависит от сайта (кнопки плеер-бара, id трека, «лайк»), вынесено
 * в профиль — он выбирается по домену страницы.
 *
 * Исполняется в главном мире страницы (webContents.executeJavaScript),
 * поэтому видит и mediaSession, и DOM сайта.
 *
 * Состояние собирается по трём источникам, от надёжного к запасному:
 *   1. navigator.mediaSession — метаданные и позиция (стандартный API,
 *      не зависит от вёрстки ЯМ);
 *   2. активный <audio>/<video> элемент — точная позиция, пауза, громкость;
 *   3. DOM плеер-бара — id трека, «лайк» и запасные кнопки управления.
 *
 * Управление идёт в обратном порядке: сначала пробуем обработчики,
 * которые сайт сам зарегистрировал в mediaSession (их вызывает и системная
 * панель ОС), затем клики по кнопкам, затем сам медиа-элемент.
 */
(function () {
  if (window.__ymPlayerBridge) return 'already';
  window.__ymPlayerBridge = true;

  var handlers = {};          // зарегистрированные сайтом обработчики mediaSession
  var positionState = null;   // последний setPositionState
  var positionAt = 0;         // performance.now() на момент его установки
  var mediaEl = null;         // последний игравший медиа-элемент
  var lastPayload = '';
  var paused = true;          // от него зависит частота опроса
  var watched = null;         // элемент, на события которого мы подписаны

  /* ---------- перехват mediaSession ---------- */

  var session = navigator.mediaSession;
  if (session) {
    var origSetHandler = session.setActionHandler.bind(session);
    session.setActionHandler = function (action, fn) {
      handlers[action] = fn;
      return origSetHandler(action, fn);
    };
    if (session.setPositionState) {
      var origSetPosition = session.setPositionState.bind(session);
      session.setPositionState = function (state) {
        if (state) {
          positionState = state;
          positionAt = performance.now();
        }
        return origSetPosition(state);
      };
    }
  }

  /* ---------- перехват медиа-элементов ---------- */

  var origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    mediaEl = this;
    return origPlay.apply(this, arguments);
  };

  /**
   * ЯМ держит пул медиа-элементов и подгружает в них следующий трек,
   * поэтому «последний игравший» не всегда тот, что звучит сейчас.
   * Выбираем играющий, затем — самый продвинутый по времени.
   */
  function activeMedia() {
    var list = Array.prototype.slice.call(document.querySelectorAll('audio, video'));
    // ВК создаёт плеер через new Audio() и в документ его не вставляет,
    // поэтому querySelectorAll его не видит — элемент даёт перехват play().
    if (mediaEl && list.indexOf(mediaEl) < 0) list.push(mediaEl);

    // Играющий элемент важнее всех прочих признаков: при потоковой отдаче
    // duration какое-то время равна NaN, и по ней элемент отбрасывать нельзя
    var playing = list.filter(function (el) { return !el.paused; });
    if (playing.length) {
      mediaEl = playing[0];
      return mediaEl;
    }

    var started = list.filter(function (el) { return el.currentTime > 0; });
    if (started.length) {
      started.sort(function (a, b) { return b.currentTime - a.currentTime; });
      mediaEl = started[0];
      return mediaEl;
    }

    // Дальше — только пустые элементы: у ЯМ это пул под следующий трек,
    // поэтому предпочитаем тот, что уже был в деле
    if (mediaEl) return mediaEl;
    return list.length ? list[0] : null;
  }

  /**
   * Подписка на события того элемента, который звучит: пауза, старт и смена
   * трека приходят сразу, без ожидания следующего опроса. Благодаря этому
   * опрос можно держать редким.
   */
  function watchMedia(el) {
    if (!el || el === watched) return;
    if (watched) {
      ['play', 'pause', 'ended', 'loadedmetadata'].forEach(function (name) {
        watched.removeEventListener(name, wake);
      });
    }
    watched = el;
    ['play', 'pause', 'ended', 'loadedmetadata'].forEach(function (name) {
      el.addEventListener(name, wake);
    });
  }

  /** Кортеж текущей аудиозаписи ВК из плеера страницы. */
  function currentVkTuple() {
    var ap = window.ap;
    if (!ap || typeof ap.getCurrentAudio !== 'function') return null;
    try {
      var tuple = ap.getCurrentAudio();
      return tuple && tuple.length ? tuple : null;
    } catch (err) {
      return null;
    }
  }

  /* ---------- DOM плеер-бара ---------- */

  function query(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  /*
   * Профили сайтов.
   *
   * ЯМ: вёрстка меняется и классы обфусцированы, а вот data-test-id и
   * aria-label кнопок плеер-бара живут долго. Метки перечислены и
   * по-русски, и по-английски — интерфейс зависит от региона аккаунта.
   *
   * ВК: у аудиозаписей есть data-full-id вида «ownerId_audioId» — то же,
   * чем трек адресуется в API, поэтому id читается прямо оттуда. Старый
   * плеер держит текущий трек в глобальном window.ap, новый — только в DOM,
   * поэтому пробуем оба.
   */
  var PROFILES = {
    ym: {
      selectors: {
        play: ['[data-test-id="PLAY_BUTTON"]', '[data-test-id="PLAYER_BAR_PLAY_BUTTON"]'],
        next: ['[data-test-id="NEXT_TRACK_BUTTON"]'],
        prev: ['[data-test-id="PREV_TRACK_BUTTON"]'],
        like: ['[data-test-id="LIKE_BUTTON"]'],
        trackLink: [
          '[data-test-id="PLAYERBAR_DESKTOP_TITLE"] a[href*="/track/"]',
          '[class*="PlayerBar"] a[href*="/track/"]',
          '[class*="player-bar"] a[href*="/track/"]',
          '[class*="Meta"] a[href*="/track/"]',
        ],
      },
      labels: {
        play: ['пауза', 'слушать', 'играть', 'воспроизвести', 'pause', 'play'],
        next: ['следующий трек', 'следующая песня', 'next song', 'next track'],
        prev: ['предыдущий трек', 'предыдущая песня', 'previous song', 'previous track'],
        like: ['мне нравится', 'нравится', 'like', 'удалить из коллекции'],
      },
      trackId: function () {
        var link = query(PROFILE.selectors.trackLink);
        if (!link) return null;
        var match = (link.getAttribute('href') || '').match(/\/track\/(\d+)/);
        return match ? match[1] : null;
      },
    },

    vk: {
      // Кнопки ВК опознаются менее уверенно, чем медиа-элемент: play/pause
      // идут через него, а клик по кнопке остаётся запасным вариантом
      preferMediaElement: true,
      selectors: {
        play: ['.top_audio_player_play', '.audio_page_player_play', '[data-testid="audioplayer_play"]'],
        next: ['.top_audio_player_next', '[data-testid="audioplayer_next"]'],
        prev: ['.top_audio_player_prev', '[data-testid="audioplayer_prev"]'],
        like: ['.top_audio_player_add', '[data-testid="audioplayer_add"]'],
        current: ['.top_audio_player[data-full-id]', '.audio_row_playing[data-full-id]',
          '.audio_row__playing[data-full-id]', '[data-full-id].audio_row_current'],
      },
      labels: {
        play: ['пауза', 'играть', 'воспроизвести', 'слушать', 'pause', 'play'],
        next: ['следующая', 'следующий трек', 'вперёд', 'next'],
        prev: ['предыдущая', 'предыдущий трек', 'назад', 'previous'],
        like: ['добавить', 'добавить к себе', 'удалить', 'удалить из моей музыки'],
      },
      /**
       * Рекламная вставка между треками. Файл приходит с того же CDN, что и
       * музыка, поэтому сетевой блокировкой её не отличить — зато в кортеже
       * аудиозаписи есть поле с параметрами рекламы, а у самой вставки нет
       * нормальных id владельца и трека.
       */
      detectAd: function () {
        var tuple = currentVkTuple();
        // У обычных треков поле с параметрами рекламы тоже заполнено —
        // одного его наличия мало. Рекламная вставка не адресуется как
        // аудиозапись: у неё нет ни id, ни владельца.
        if (tuple && tuple.length > 1 && (!tuple[0] || !tuple[1] || String(tuple[1]) === '0')) {
          return { title: String(tuple[3] || 'реклама'), reason: 'нет id' };
        }
        var marker = document.querySelector(
          '.audio_page_player_ads, .top_audio_player_ads, [class*="audio_ads"]'
        );
        return marker ? { title: 'реклама', reason: 'разметка' } : null;
      },

      /** id трека в ВК — «ownerId_audioId»: им же адресуется API. */
      trackId: function () {
        // кортеж аудиозаписи: [0] — id, [1] — id владельца
        var tuple = currentVkTuple();
        if (tuple && tuple.length > 1) return tuple[1] + '_' + tuple[0];
        var el = query(PROFILE.selectors.current);
        return el ? el.getAttribute('data-full-id') : null;
      },
    },
  };

  var PROFILE = /(^|\.)vk\.(ru|com)$/.test(location.hostname) ? PROFILES.vk : PROFILES.ym;

  /** Ищет кнопку по точному совпадению aria-label (регистр не важен). */
  function findByLabel(kind) {
    var wanted = PROFILE.labels[kind];
    if (!wanted) return null;
    var buttons = document.querySelectorAll('button[aria-label], [role="button"][aria-label]');
    for (var i = 0; i < buttons.length; i++) {
      var label = (buttons[i].getAttribute('aria-label') || '').trim().toLowerCase();
      if (wanted.indexOf(label) >= 0) return buttons[i];
    }
    return null;
  }

  function clickButton(kind) {
    var el = query(PROFILE.selectors[kind]) || findByLabel(kind);
    if (!el) return false;
    el.click();
    return true;
  }

  function currentTrackId() {
    try {
      return PROFILE.trackId();
    } catch (err) {
      return null;
    }
  }

  function isLiked() {
    var el = query(PROFILE.selectors.like) || findByLabel('like');
    if (!el) return null;
    var pressed = el.getAttribute('aria-pressed');
    if (pressed !== null) return pressed === 'true';
    // Подпись кнопки говорит о действии, а не о состоянии:
    // «Мне нравится» — трек ещё не лайкнут, «Удалить…» — уже лайкнут
    var label = (el.getAttribute('aria-label') || '').trim().toLowerCase();
    if (label.indexOf('удалить') >= 0 || label.indexOf('remove') >= 0) return true;
    if (label === 'like' || label === 'мне нравится' || label === 'нравится') return false;
    return null;
  }

  /* ---------- чтение состояния ---------- */

  function readMetadata() {
    var meta = session && session.metadata;
    if (!meta) return { title: '', artist: '', album: '', artwork: '' };
    var artwork = '';
    var list = meta.artwork || [];
    if (list.length) {
      // берём картинку покрупнее — виджет показывает обложку ~80px в 2x
      var best = list[list.length - 1];
      for (var i = 0; i < list.length; i++) {
        var size = parseInt((list[i].sizes || '0x0').split('x')[0], 10) || 0;
        var bestSize = parseInt((best.sizes || '0x0').split('x')[0], 10) || 0;
        if (size > bestSize) best = list[i];
      }
      artwork = best.src || '';
    }
    return {
      title: meta.title || '',
      artist: meta.artist || '',
      album: meta.album || '',
      artwork: artwork,
    };
  }

  function readState() {
    var el = activeMedia();
    watchMedia(el);
    var meta = readMetadata();

    var duration = 0;
    var position = 0;
    if (el && isFinite(el.duration) && el.duration > 0) {
      duration = el.duration;
      position = el.currentTime;
    } else if (positionState) {
      duration = positionState.duration || 0;
      position = positionState.position || 0;
      if (session && session.playbackState === 'playing') {
        position += ((performance.now() - positionAt) / 1000) * (positionState.playbackRate || 1);
      }
      if (duration) position = Math.min(position, duration);
    }

    // Сам медиа-элемент — источник правды: ЯМ не всегда обновляет
    // mediaSession.playbackState при паузе
    var paused;
    if (el) {
      paused = el.paused;
    } else if (session && session.playbackState && session.playbackState !== 'none') {
      paused = session.playbackState !== 'playing';
    } else {
      paused = true;
    }

    return {
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      artwork: meta.artwork,
      duration: duration,
      position: position,
      paused: paused,
      volume: el ? el.volume : 1,
      muted: el ? el.muted : false,
      service: PROFILE === PROFILES.vk ? 'vk' : 'ym',
      trackId: currentTrackId(),
      liked: isLiked(),
      hasTrack: Boolean(meta.title || (el && el.src)),
    };
  }

  /* ---------- управление ---------- */

  function call(action) {
    var fn = handlers[action];
    if (typeof fn !== 'function') return false;
    try {
      fn({ action: action });
      return true;
    } catch (err) {
      return false;
    }
  }

  window.__ymPlayer = {
    getState: readState,

    play: function () {
      if (call('play')) return 'mediaSession';
      if (PROFILE.preferMediaElement) {
        var media = activeMedia();
        if (media) { media.play(); return 'media'; }
      }
      if (clickButton('play')) return 'button';
      var el = activeMedia();
      if (el) { el.play(); return 'media'; }
      return false;
    },

    pause: function () {
      if (call('pause')) return 'mediaSession';
      // У ВК кнопки плеер-бара приходится угадывать по классам, а клик по
      // не той кнопке выглядел бы как успех. Медиа-элемент надёжнее:
      // он останавливает звук независимо от вёрстки.
      if (PROFILE.preferMediaElement) {
        var media = activeMedia();
        if (media) { media.pause(); return 'media'; }
      }
      if (clickButton('play')) return 'button';
      var el = activeMedia();
      if (el) { el.pause(); return 'media'; }
      return false;
    },

    toggle: function () {
      return readState().paused ? this.play() : this.pause();
    },

    next: function () {
      return call('nexttrack') || clickButton('next');
    },

    prev: function () {
      return call('previoustrack') || clickButton('prev');
    },

    seek: function (seconds) {
      var el = activeMedia();
      if (el && isFinite(el.duration)) {
        el.currentTime = Math.max(0, Math.min(seconds, el.duration));
        return true;
      }
      var fn = handlers.seekto;
      if (typeof fn === 'function') {
        try { fn({ action: 'seekto', seekTime: seconds }); return true; } catch (err) { /* ниже */ }
      }
      return false;
    },

    setVolume: function (value) {
      var el = activeMedia();
      if (!el) return false;
      el.volume = Math.max(0, Math.min(1, value));
      el.muted = false;
      return true;
    },

    like: function () {
      return clickButton('like');
    },

    // Открыть модалки, объявленные в inject.js
    openSettings: function () {
      if (typeof window.__ymOpenSettings === 'function') { window.__ymOpenSettings(); return true; }
      return false;
    },
    openToken: function () {
      if (typeof window.__ymOpenToken === 'function') { window.__ymOpenToken(function () {}); return true; }
      return false;
    },
  };

  /* ---------- пропуск рекламы ---------- */

  var adSkipAt = 0;      // когда пробовали в последний раз
  var adMuted = false;   // мы ли заглушили звук
  /**
   * Рекламную вставку сначала глушим и проматываем в конец, и только если
   * это не помогло — переключаем трек: перемотка не сбивает очередь
   * воспроизведения, а «следующий» может увести с нужного места плейлиста.
   *
   * Выключается настройкой блокировщика рекламы (window.__ymSkipAds).
   */
  function skipAdIfPlaying() {
    if (!PROFILE.detectAd || window.__ymSkipAds === false) return;

    var ad = PROFILE.detectAd();
    if (!ad) {
      // реклама кончилась — снимаем свою заглушку
      if (adMuted) {
        var current = activeMedia();
        if (current) current.muted = false;
        adMuted = false;
      }
      return;
    }

    var now = Date.now();
    if (now - adSkipAt < 2000) return;
    adSkipAt = now;

    var el = activeMedia();
    if (el) {
      el.muted = true;
      adMuted = true;
      if (isFinite(el.duration) && el.duration > 0) {
        try { el.currentTime = Math.max(0, el.duration - 0.2); } catch (err) { /* ниже — next */ }
      }
    }
    if (window.__ymHost) {
      window.__ymHost.log('ВК: пропускаю рекламу «' + ad.title + '» (' + ad.reason + ')');
    }

    // перемотка у рекламы часто запрещена — тогда уходим на следующий трек
    setTimeout(function () {
      if (PROFILE.detectAd()) window.__ymPlayer.next();
    }, 1200);
  }

  /* ---------- публикация состояния ---------- */

  function publish(force) {
    if (!window.__ymHost) return;
    var state = readState();
    paused = state.paused;
    // позицию из сравнения исключаем — она меняется постоянно
    var signature = JSON.stringify([state.title, state.artist, state.album, state.artwork,
      state.paused, Math.round(state.duration), state.trackId, state.liked,
      Math.round(state.position)]);
    if (!force && signature === lastPayload) return;
    lastPayload = signature;
    window.__ymHost.publish(state);
  }

  /*
   * Опрос подстраивается под воспроизведение. Каждый проход перебирает DOM
   * страницы сервиса, а это дорого: во время паузы позиция не движется и
   * проверять её дважды в секунду незачем. О смене состояния сообщает сам
   * медиа-элемент — на события подписываемся в watchMedia().
   */
  var ACTIVE_INTERVAL = 500;
  var IDLE_INTERVAL = 2000;
  var tickTimer = null;

  function tick() {
    skipAdIfPlaying();
    publish();
    schedule();
  }

  function schedule() {
    clearTimeout(tickTimer);
    tickTimer = setTimeout(tick, paused ? IDLE_INTERVAL : ACTIVE_INTERVAL);
  }

  /** Немедленно сообщить о смене состояния и вернуться к частому опросу. */
  function wake() {
    publish(true);
    schedule();
  }

  publish(true);
  schedule();

  return 'ok';
})();
