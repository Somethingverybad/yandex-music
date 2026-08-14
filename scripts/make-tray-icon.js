#!/usr/bin/env node
'use strict';
/**
 * Рисует значок для строки меню macOS: assets/trayTemplate.png и @2x.
 *
 * Нативные значки в строке меню — монохромные силуэты, которые система сама
 * перекрашивает под светлую и тёмную тему и под подсветку при нажатии. Такой
 * образ называется template: значимы только альфа-канал и чёрный цвет.
 * Цветная иконка приложения там выглядит чужеродно и крупно.
 *
 * Рисуем сами: ImageMagick и rsvg в системе может не быть, а тащить
 * зависимость ради одного значка незачем. Сглаживание — суперсэмплингом.
 *
 * Запуск: node scripts/make-tray-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'assets');
const SUPERSAMPLE = 8;

/* ---------- фигура ноты в координатах 16×16 ---------- */

const HEAD = { x: 5.6, y: 11.5, r: 3.5 };
const STEM = { left: 8.3, right: 9.7, top: 3.0, bottom: 11.6 };
// Флажок восьмой ноты: полоса от верха ножки вправо и вниз
const FLAG = [
  [9.7, 3.0], [13.4, 4.7], [13.4, 6.6], [9.7, 4.9],
];

function inCircle(x, y, circle) {
  const dx = x - circle.x;
  const dy = y - circle.y;
  return dx * dx + dy * dy <= circle.r * circle.r;
}

function inRect(x, y, rect) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** Чётно-нечётный тест принадлежности точки многоугольнику. */
function inPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersects = (yi > y) !== (yj > y)
      && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function covered(x, y) {
  return inCircle(x, y, HEAD) || inRect(x, y, STEM) || inPolygon(x, y, FLAG);
}

/** RGBA-пиксели: чёрный силуэт, прозрачный фон, сглаживание по покрытию. */
function render(size) {
  const scale = size / 16;
  const pixels = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / scale;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / scale;
          if (covered(x, y)) hits++;
        }
      }
      const alpha = Math.round((hits / (SUPERSAMPLE * SUPERSAMPLE)) * 255);
      const offset = (py * size + px) * 4;
      pixels[offset] = 0;
      pixels[offset + 1] = 0;
      pixels[offset + 2] = 0;
      pixels[offset + 3] = alpha;
    }
  }
  return pixels;
}

/* ---------- минимальный PNG ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

function encodePng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // бит на канал
  header[9] = 6;   // RGBA
  header[10] = 0;  // deflate
  header[11] = 0;  // фильтрация по умолчанию
  header[12] = 0;  // без чересстрочности

  // каждая строка предваряется байтом фильтра
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [size, name] of [[16, 'trayTemplate.png'], [32, 'trayTemplate@2x.png']]) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, encodePng(render(size), size));
  console.log(`${name}: ${size}×${size}`);
}
