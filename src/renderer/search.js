'use strict';
/** Поиск по ВК Музыке: список результатов, клик — играть, стрелка — скачать. */

const el = (id) => document.getElementById(id);
const results = el('results');
const query = el('query');

let tracks = [];
let searchTimer = null;
let requestId = 0;

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function message(text, isError) {
  results.innerHTML = '';
  const node = document.createElement('p');
  node.className = 'status' + (isError ? ' error' : '');
  node.textContent = text;
  results.appendChild(node);
}

const DOWNLOAD_ICON = 'M12 3v10.6l3.3-3.3 1.4 1.4L12 17.4l-4.7-5.7 1.4-1.4L12 13.6V3zM5 19h14v2H5z';

function render() {
  results.innerHTML = '';

  tracks.forEach((track, position) => {
    const row = document.createElement('div');
    row.className = 'track';

    const cover = document.createElement('div');
    cover.className = 'cover';
    // обложка есть не у всякого трека — тогда остаётся просто плашка
    if (track.cover) cover.style.backgroundImage = `url("${track.cover}")`;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = track.title || 'Без названия';
    const artist = document.createElement('div');
    artist.className = 'artist';
    artist.textContent = track.artist || 'Неизвестный исполнитель';
    meta.append(title, artist);

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(track.duration);

    const download = document.createElement('button');
    download.className = 'download';
    download.title = 'Скачать';
    download.innerHTML = `<svg viewBox="0 0 24 24"><path d="${DOWNLOAD_ICON}"/></svg>`;
    download.addEventListener('click', async (event) => {
      // клик по строке запускает трек — для кнопки это лишнее
      event.stopPropagation();
      download.classList.add('busy');
      const result = await window.searchApi.download(position);
      download.classList.remove('busy');
      download.title = result && result.ok === false
        ? `Не удалось: ${result.error}`
        : 'Скачано';
    });

    row.addEventListener('click', () => {
      document.querySelectorAll('.track.playing').forEach((node) => node.classList.remove('playing'));
      row.classList.add('playing');
      window.searchApi.play(position);
    });

    row.append(cover, meta, time, download);
    results.appendChild(row);
  });
}

async function run(text) {
  const mine = ++requestId;
  message('Ищу…');
  try {
    const found = await window.searchApi.search(text);
    // пока ждали, мог уйти следующий запрос — его ответ важнее
    if (mine !== requestId) return;
    tracks = Array.isArray(found) ? found : [];
    if (!tracks.length) {
      message('Ничего не нашлось');
      return;
    }
    render();
  } catch (err) {
    if (mine === requestId) message('Поиск не удался: ' + err.message, true);
  }
}

query.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const text = query.value.trim();
  if (!text) {
    tracks = [];
    message('Введите запрос');
    return;
  }
  // не дёргаем ВК на каждую букву
  searchTimer = setTimeout(() => run(text), 400);
});

query.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    clearTimeout(searchTimer);
    const text = query.value.trim();
    if (text) run(text);
  }
  if (event.key === 'Escape') window.searchApi.close();
});
