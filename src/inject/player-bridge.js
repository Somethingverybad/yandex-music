/**
 * Драйвер плеера Яндекс Музыки. Исполняется в главном мире страницы
 * (webContents.executeJavaScript), поэтому видит и mediaSession, и DOM сайта.
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
    if (mediaEl && mediaEl.isConnected && list.indexOf(mediaEl) < 0) list.push(mediaEl);

    var playable = list.filter(function (el) {
      return isFinite(el.duration) && el.duration > 0;
    });

    var playing = playable.filter(function (el) { return !el.paused; });
    if (playing.length) {
      mediaEl = playing[0];
      return mediaEl;
    }

    var started = playable.filter(function (el) { return el.currentTime > 0; });
    if (started.length) {
      started.sort(function (a, b) { return b.currentTime - a.currentTime; });
      mediaEl = started[0];
      return mediaEl;
    }

    if (mediaEl && mediaEl.isConnected) return mediaEl;
    return list.length ? list[0] : null;
  }

  /* ---------- DOM плеер-бара ---------- */

  function query(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  // Вёрстка ЯМ меняется и классы обфусцированы, а вот data-test-id и
  // aria-label кнопок плеер-бара живут долго. Метки перечислены и
  // по-русски, и по-английски — интерфейс зависит от региона аккаунта.
  var SELECTORS = {
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
  };

  var LABELS = {
    play: ['пауза', 'слушать', 'играть', 'воспроизвести', 'pause', 'play'],
    next: ['следующий трек', 'следующая песня', 'next song', 'next track'],
    prev: ['предыдущий трек', 'предыдущая песня', 'previous song', 'previous track'],
    like: ['мне нравится', 'нравится', 'like', 'удалить из коллекции'],
  };

  /** Ищет кнопку по точному совпадению aria-label (регистр не важен). */
  function findByLabel(kind) {
    var wanted = LABELS[kind];
    if (!wanted) return null;
    var buttons = document.querySelectorAll('button[aria-label], [role="button"][aria-label]');
    for (var i = 0; i < buttons.length; i++) {
      var label = (buttons[i].getAttribute('aria-label') || '').trim().toLowerCase();
      if (wanted.indexOf(label) >= 0) return buttons[i];
    }
    return null;
  }

  function clickButton(kind) {
    var el = query(SELECTORS[kind]) || findByLabel(kind);
    if (!el) return false;
    el.click();
    return true;
  }

  function currentTrackId() {
    var link = query(SELECTORS.trackLink);
    if (!link) return null;
    var match = (link.getAttribute('href') || '').match(/\/track\/(\d+)/);
    return match ? match[1] : null;
  }

  function isLiked() {
    var el = query(SELECTORS.like) || findByLabel('like');
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
      if (call('play')) return true;
      if (clickButton('play')) return true;
      var el = activeMedia();
      if (el) { el.play(); return true; }
      return false;
    },

    pause: function () {
      if (call('pause')) return true;
      if (clickButton('play')) return true;
      var el = activeMedia();
      if (el) { el.pause(); return true; }
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

  /* ---------- публикация состояния ---------- */

  function publish(force) {
    if (!window.__ymHost) return;
    var state = readState();
    // позицию из сравнения исключаем — она меняется постоянно
    var signature = JSON.stringify([state.title, state.artist, state.album, state.artwork,
      state.paused, Math.round(state.duration), state.trackId, state.liked,
      Math.round(state.position)]);
    if (!force && signature === lastPayload) return;
    lastPayload = signature;
    window.__ymHost.publish(state);
  }

  setInterval(publish, 500);
  publish(true);

  return 'ok';
})();
