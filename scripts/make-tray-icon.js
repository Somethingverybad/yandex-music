#!/usr/bin/env electron
'use strict';
/**
 * Делает значок для строки меню macOS: assets/trayTemplate.png и @2x.
 *
 * Нативные значки там — монохромные силуэты, которые система сама
 * перекрашивает под светлую и тёмную тему и подсвечивает при нажатии. Такой
 * образ называется template: значимы альфа-канал и чёрный цвет. Исходник
 * (assets/tray-source.png) белый, поэтому цвет мы обнуляем, а прозрачность
 * оставляем как есть.
 *
 * Работает через nativeImage: он умеет и качественно уменьшать, и отдавать
 * пиксели, так что сторонние конвертеры вроде ImageMagick не нужны.
 *
 * Запуск: npm run prepare:tray-icon
 */
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const ASSETS = path.join(__dirname, '..', 'assets');
const SOURCE = path.join(ASSETS, 'tray-source.png');

/** Красит непрозрачные пиксели в чёрный, не трогая альфу. */
function toTemplate(image) {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();     // BGRA
  for (let i = 0; i < bitmap.length; i += 4) {
    bitmap[i] = 0;
    bitmap[i + 1] = 0;
    bitmap[i + 2] = 0;
  }
  return nativeImage.createFromBuffer(bitmap, { width, height });
}

app.whenReady().then(() => {
  if (!fs.existsSync(SOURCE)) {
    console.error('Нет исходника: %s', SOURCE);
    app.exit(1);
    return;
  }

  const source = nativeImage.createFromPath(SOURCE);
  if (source.isEmpty()) {
    console.error('Не удалось прочитать %s', SOURCE);
    app.exit(1);
    return;
  }

  for (const [size, name] of [[16, 'trayTemplate.png'], [32, 'trayTemplate@2x.png']]) {
    const resized = source.resize({ width: size, height: size, quality: 'best' });
    const file = path.join(ASSETS, name);
    fs.writeFileSync(file, toTemplate(resized).toPNG());
    console.log('%s: %d×%d', name, size, size);
  }

  app.quit();
});
