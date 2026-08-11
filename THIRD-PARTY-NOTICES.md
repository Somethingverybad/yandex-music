# Сторонние компоненты

Проект включает код следующих проектов. Все они распространяются под MIT —
лицензия требует сохранять уведомление об авторстве и текст разрешения,
что и сделано ниже.

## ya-music-desktop

<https://github.com/cptn73m0/ya-music-desktop>

Откуда взято:

* `src/inject/inject.js` — перенесён целиком (кнопки «Скачать» в интерфейсе
  Яндекс Музыки, модалки токена и настроек, блокировщик рекламы, тосты);
  добавлены только три строки экспорта для оболочки на Electron;
* `src/main/downloader.js` — порт `core/downloader.py` на Node: раскладка
  по каталогам, санитайзер имён файлов, простановка ID3-тегов;
* `src/main/config.js` — состав и семантика настроек загрузки из
  `core/settings.py`;
* `assets/icon.png` — иконка приложения (извлечена из `assets/icon.ico`).

```
MIT License

Copyright (c) 2026 cptn73m0

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Liquid Glass for GNOME Shell

<https://github.com/ryohsuke1231/liquid-glass>

Откуда взято: `src/renderer/glass-gl.js` — оптика стекла портирована из
`shaders/glass.frag` (SDF скруглённого прямоугольника, суперэллиптический
профиль высоты, нормаль через конечные разности, преломление по Снеллиусу
с заданным IOR, хроматическая аберрация, подсветка кромки и блик).
Оригинал написан под Cogl-пайплайн GNOME Shell, здесь то же самое сделано
на WebGL.

```
MIT License

Copyright (c) 2026 Ryosuke Watanabe

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Что не является заимствованием

`src/main/ym-api.js` — самостоятельная реализация обращений к API Яндекс
Музыки: эндпоинты, формат ответа `download-info` и схема подписи ссылки
на файл являются описанием протокола, а не чужим кодом.

## Зависимости

Устанавливаются через npm и в репозиторий не входят; их лицензии лежат
в `node_modules/<пакет>/LICENSE`:

| Пакет | Лицензия |
| --- | --- |
| electron | MIT |
| electron-builder | MIT |
| node-id3 | MIT |
| mpris-service | MIT |
| dbus-next | MIT |
