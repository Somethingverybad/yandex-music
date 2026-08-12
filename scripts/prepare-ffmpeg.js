#!/usr/bin/env node
'use strict';
/**
 * Готовит бинарник ffmpeg в assets/bin — его использует загрузчик, когда
 * сервис отдаёт трек потоком HLS (см. src/main/ffmpeg.js).
 *
 * В репозитории бинарника нет: он весит десятки мегабайт и зависит от
 * платформы. Пакет ffmpeg-static умеет качать только под текущую машину,
 * поэтому здесь мы дёргаем его установщик по разу на архитектуру, а на
 * macOS дополнительно склеиваем результат в universal через lipo —
 * иначе сборка --universal получится нерабочей на половине маков.
 *
 * Запуск: npm run prepare:ffmpeg [--arch=arm64,x64] [--platform=darwin]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INSTALLER = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'install.js');
const DOWNLOADED = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg');
const OUT_DIR = path.join(ROOT, 'assets', 'bin');

function arg(name, fallback) {
  const found = process.argv.find((item) => item.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const platform = arg('platform', process.platform);
const defaultArches = platform === 'darwin' ? 'arm64,x64' : process.arch;
const arches = arg('arch', defaultArches).split(',').filter(Boolean);
const outName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

if (!fs.existsSync(INSTALLER)) {
  console.error('Нет пакета ffmpeg-static. Сначала: npm install');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

/** Установщик пропускает загрузку, если файл уже на месте, — убираем его. */
function download(arch) {
  fs.rmSync(DOWNLOADED, { force: true });
  console.log(`> качаю ffmpeg для ${platform}-${arch}`);
  execFileSync(process.execPath, [INSTALLER], {
    stdio: 'inherit',
    env: { ...process.env, npm_config_platform: platform, npm_config_arch: arch },
  });
  const copy = path.join(OUT_DIR, `${outName}.${arch}`);
  fs.copyFileSync(DOWNLOADED, copy);
  return copy;
}

const parts = arches.map(download);
const target = path.join(OUT_DIR, outName);

if (parts.length === 1) {
  fs.renameSync(parts[0], target);
} else {
  console.log('> склеиваю universal через lipo');
  execFileSync('lipo', ['-create', ...parts, '-output', target], { stdio: 'inherit' });
  parts.forEach((part) => fs.rmSync(part, { force: true }));
}

fs.chmodSync(target, 0o755);
const size = (fs.statSync(target).size / 1024 / 1024).toFixed(0);
console.log(`Готово: ${path.relative(ROOT, target)} (${size} МБ, ${arches.join(' + ')})`);
