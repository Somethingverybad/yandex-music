'use strict';
/** Окно настроек: общие параметры загрузок и то, что зависит от сервиса. */

const el = (id) => document.getElementById(id);

const ui = {
  path: el('download-path'),
  layout: el('layout'),
  skipExisting: el('skip-existing'),
  blockAds: el('block-ads'),
  bitrate: el('bitrate'),
  token: el('token'),
  tokenStatus: el('token-status'),
  vkEnabled: el('vk-enabled'),
  vkNote: el('vk-note'),
  opacity: el('opacity'),
  opacityValue: el('opacity-value'),
  accentYm: el('accent-ym'),
  accentVk: el('accent-vk'),
  saved: el('saved'),
};

// Заводские цвета акцента — те же, что в настройках по умолчанию
const DEFAULT_ACCENT = { ym: '#ffdb4d', vk: '#4aa1ff' };

/** Сообщение под кнопками — исчезает само. */
let noticeTimer = null;
function notice(message, isError) {
  clearTimeout(noticeTimer);
  ui.saved.textContent = message;
  ui.saved.classList.toggle('error', Boolean(isError));
  ui.saved.classList.add('show');
  noticeTimer = setTimeout(() => ui.saved.classList.remove('show'), 2500);
}

async function load() {
  const cfg = await window.settingsApi.get();
  ui.path.value = cfg.download_path || '';
  ui.layout.value = cfg.download_layout || 'artist';
  ui.skipExisting.checked = cfg.skip_existing !== false;
  ui.blockAds.checked = cfg.block_ads !== false;
  ui.bitrate.value = String(cfg.preferred_bitrate || 320);
  ui.vkEnabled.checked = cfg.vk_enabled !== false;

  const opacity = Math.round((cfg.widget_opacity != null ? cfg.widget_opacity : 1) * 100);
  ui.opacity.value = String(opacity);
  ui.opacityValue.textContent = opacity + '%';
  ui.accentYm.value = cfg.widget_accent_ym || DEFAULT_ACCENT.ym;
  ui.accentVk.value = cfg.widget_accent_vk || DEFAULT_ACCENT.vk;

  ui.vkNote.textContent = 'ВК отдаёт часть треков потоком HLS — такие пока не '
    + 'скачиваются, приложение честно сообщит об этом вместо битого файла.';

  await refreshToken();
}

async function refreshToken() {
  const authorized = await window.settingsApi.isAuthorized();
  ui.tokenStatus.textContent = authorized
    ? 'Токен сохранён — скачивание доступно'
    : 'Токена нет — скачивание из Яндекс Музыки недоступно';
  ui.tokenStatus.classList.toggle('ok', authorized);
  ui.tokenStatus.classList.toggle('warn', !authorized);
}

async function save() {
  const result = await window.settingsApi.save({
    download_path: ui.path.value.trim(),
    download_layout: ui.layout.value,
    skip_existing: ui.skipExisting.checked,
    block_ads: ui.blockAds.checked,
    preferred_bitrate: parseInt(ui.bitrate.value, 10),
    vk_enabled: ui.vkEnabled.checked,
    widget_opacity: parseInt(ui.opacity.value, 10) / 100,
    widget_accent_ym: ui.accentYm.value,
    widget_accent_vk: ui.accentVk.value,
  });
  if (result && result.ok === false) {
    notice(result.error || 'Не удалось сохранить', true);
    return;
  }
  notice('Настройки сохранены');
}

// Прозрачность и цвет применяются сразу: подбирать их вслепую,
// сохраняя после каждого шага, неудобно
ui.opacity.addEventListener('input', () => {
  ui.opacityValue.textContent = ui.opacity.value + '%';
  window.settingsApi.preview({ widget_opacity: parseInt(ui.opacity.value, 10) / 100 });
});

ui.accentYm.addEventListener('input', () => {
  window.settingsApi.preview({ widget_accent_ym: ui.accentYm.value });
});

ui.accentVk.addEventListener('input', () => {
  window.settingsApi.preview({ widget_accent_vk: ui.accentVk.value });
});

el('accent-reset').addEventListener('click', () => {
  ui.accentYm.value = DEFAULT_ACCENT.ym;
  ui.accentVk.value = DEFAULT_ACCENT.vk;
  window.settingsApi.preview({
    widget_accent_ym: DEFAULT_ACCENT.ym,
    widget_accent_vk: DEFAULT_ACCENT.vk,
  });
});

el('browse').addEventListener('click', async () => {
  const result = await window.settingsApi.browsePath();
  if (result && result.path) ui.path.value = result.path;
});

el('token-save').addEventListener('click', async () => {
  const token = ui.token.value.trim();
  if (!token) {
    notice('Вставьте токен', true);
    return;
  }
  const result = await window.settingsApi.saveToken(token);
  ui.token.value = '';
  if (result && result.ok === false) {
    notice(result.error || 'Токен не сохранён', true);
  } else {
    notice(result && result.warning ? result.warning : 'Токен сохранён');
  }
  await refreshToken();
});

// Окно авторизации ловит access_token из адреса само — руками вставлять
// его нужно, только если перехват не сработал
el('token-get').addEventListener('click', () => window.settingsApi.getToken());
el('vk-open').addEventListener('click', () => window.settingsApi.openVk());
el('save').addEventListener('click', save);
el('close').addEventListener('click', () => window.settingsApi.close());

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.settingsApi.close();
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
});

load().catch((err) => notice('Не удалось прочитать настройки: ' + err.message, true));
