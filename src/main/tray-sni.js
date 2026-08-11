'use strict';
/**
 * Собственная иконка в системном трее Linux (StatusNotifierItem + dbusmenu).
 *
 * Почему не встроенный Tray из Electron: он отдаёт оболочке только имя
 * иконки и путь к временному каталогу (IconThemePath=/tmp/org.chromium.*),
 * а расширение GNOME ubuntu-appindicators этот путь не резолвит — индикатор
 * появляется в DBus, но рисуется пустым местом и не реагирует на клики.
 * Здесь иконка передаётся пикселями (IconPixmap), резолвить нечего.
 *
 * На не-Linux и при отсутствии StatusNotifierWatcher модуль сообщает
 * о неудаче, и вызывающий код откатывается на обычный Tray.
 */
const dbus = require('dbus-next');

const { Interface, ACCESS_READ, property, method, signal } = dbus.interface;
const { Variant } = dbus;

let bus = null;
let itemInterface = null;
let menuInterface = null;
let handlers = { onActivate: () => {}, getMenu: () => [] };
let stopped = false;

/** Electron отдаёт BGRA, спецификация SNI требует ARGB32 big-endian. */
function toArgbPixmap(image) {
  const { width, height } = image.getSize();
  const bgra = image.toBitmap();
  const argb = Buffer.allocUnsafe(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    argb[i] = bgra[i + 3];      // A
    argb[i + 1] = bgra[i + 2];  // R
    argb[i + 2] = bgra[i + 1];  // G
    argb[i + 3] = bgra[i];      // B
  }
  return [[width, height, argb]];
}

/* ------------------------------------------------------------------ */
/* Меню (com.canonical.dbusmenu)                                       */
/* ------------------------------------------------------------------ */

class DbusMenu extends Interface {
  constructor(path) {
    super(path);
    this._revision = 1;
    this._items = [];      // [{ id, label, type, enabled, checked, click }]
  }

  /** items: [{ label, type: 'normal'|'separator'|'checkbox', enabled, checked, click }] */
  setItems(items) {
    this._items = items.map((item, index) => ({ ...item, id: index + 1 }));
    this._revision += 1;
    try {
      this.LayoutUpdated(this._revision, 0);
    } catch (err) {
      // шина могла закрыться — меню всё равно уже никому не нужно
    }
  }

  _properties(item) {
    if (item.type === 'separator') {
      return { type: new Variant('s', 'separator') };
    }
    const props = {
      label: new Variant('s', item.label || ''),
      enabled: new Variant('b', item.enabled !== false),
      visible: new Variant('b', true),
    };
    if (item.type === 'checkbox') {
      props['toggle-type'] = new Variant('s', 'checkmark');
      props['toggle-state'] = new Variant('i', item.checked ? 1 : 0);
    }
    return props;
  }

  GetLayout(parentId, recursionDepth, propertyNames) {
    const children = this._items.map((item) => new Variant('(ia{sv}av)', [
      item.id, this._properties(item), [],
    ]));
    return [this._revision, [0, { 'children-display': new Variant('s', 'submenu') }, children]];
  }

  GetGroupProperties(ids, propertyNames) {
    return this._items
      .filter((item) => !ids.length || ids.includes(item.id))
      .map((item) => [item.id, this._properties(item)]);
  }

  GetProperty(id, name) {
    const item = this._items.find((entry) => entry.id === id);
    const props = item ? this._properties(item) : {};
    return props[name] || new Variant('s', '');
  }

  Event(id, eventId, data, timestamp) {
    if (eventId !== 'clicked') return;
    const item = this._items.find((entry) => entry.id === id);
    if (item && typeof item.click === 'function') item.click();
  }

  EventGroup(events) {
    for (const event of events) this.Event(event[0], event[1], event[2], event[3]);
    return [];
  }

  AboutToShow() {
    return false;
  }

  AboutToShowGroup(ids) {
    return [[], []];
  }

  LayoutUpdated(revision, parent) {
    return [revision, parent];
  }

  ItemsPropertiesUpdated(updated, removed) {
    return [updated, removed];
  }

  get Version() { return 3; }
  get Status() { return 'normal'; }
  get TextDirection() { return 'ltr'; }
  get IconThemePath() { return []; }
}

DbusMenu.configureMembers({
  properties: {
    Version: { signature: 'u', access: ACCESS_READ },
    Status: { signature: 's', access: ACCESS_READ },
    TextDirection: { signature: 's', access: ACCESS_READ },
    IconThemePath: { signature: 'as', access: ACCESS_READ },
  },
  methods: {
    GetLayout: { inSignature: 'iias', outSignature: 'u(ia{sv}av)' },
    GetGroupProperties: { inSignature: 'aias', outSignature: 'a(ia{sv})' },
    GetProperty: { inSignature: 'is', outSignature: 'v' },
    Event: { inSignature: 'isvu', outSignature: '' },
    EventGroup: { inSignature: 'a(isvu)', outSignature: 'ai' },
    AboutToShow: { inSignature: 'i', outSignature: 'b' },
    AboutToShowGroup: { inSignature: 'ai', outSignature: 'aiai' },
  },
  signals: {
    LayoutUpdated: { signature: 'ui' },
    ItemsPropertiesUpdated: { signature: 'a(ia{sv})a(ias)' },
  },
});

/* ------------------------------------------------------------------ */
/* Сам индикатор (org.kde.StatusNotifierItem)                          */
/* ------------------------------------------------------------------ */

class StatusNotifierItem extends Interface {
  constructor(path, { id, title, pixmap }) {
    super(path);
    this._id = id;
    this._title = title;
    this._tooltip = title;
    this._pixmap = pixmap;
  }

  setIcon(pixmap) {
    this._pixmap = pixmap;
    try { this.NewIcon(); } catch (_) { /* шина закрыта */ }
  }

  setTooltip(text) {
    this._tooltip = text || this._title;
    try { this.NewToolTip(); } catch (_) { /* шина закрыта */ }
  }

  Activate(x, y) { handlers.onActivate(); }
  SecondaryActivate(x, y) { handlers.onActivate(); }
  Scroll(delta, orientation) { /* прокрутка над иконкой не используется */ }
  ContextMenu(x, y) { /* меню рисует оболочка через dbusmenu */ }

  NewIcon() {}
  NewToolTip() {}
  NewStatus(status) { return status; }

  get Category() { return 'ApplicationStatus'; }
  get Id() { return this._id; }
  get Title() { return this._title; }
  get Status() { return 'Active'; }
  get WindowId() { return 0; }
  get IconName() { return ''; }
  get IconPixmap() { return this._pixmap; }
  get OverlayIconName() { return ''; }
  get OverlayIconPixmap() { return []; }
  get AttentionIconName() { return ''; }
  get AttentionIconPixmap() { return []; }
  get AttentionMovieName() { return ''; }
  get ToolTip() { return ['', [], this._title, this._tooltip]; }
  get ItemIsMenu() { return false; }
  get Menu() { return '/MenuBar'; }
}

StatusNotifierItem.configureMembers({
  properties: {
    Category: { signature: 's', access: ACCESS_READ },
    Id: { signature: 's', access: ACCESS_READ },
    Title: { signature: 's', access: ACCESS_READ },
    Status: { signature: 's', access: ACCESS_READ },
    WindowId: { signature: 'i', access: ACCESS_READ },
    IconName: { signature: 's', access: ACCESS_READ },
    IconPixmap: { signature: 'a(iiay)', access: ACCESS_READ },
    OverlayIconName: { signature: 's', access: ACCESS_READ },
    OverlayIconPixmap: { signature: 'a(iiay)', access: ACCESS_READ },
    AttentionIconName: { signature: 's', access: ACCESS_READ },
    AttentionIconPixmap: { signature: 'a(iiay)', access: ACCESS_READ },
    AttentionMovieName: { signature: 's', access: ACCESS_READ },
    ToolTip: { signature: '(sa(iiay)ss)', access: ACCESS_READ },
    ItemIsMenu: { signature: 'b', access: ACCESS_READ },
    Menu: { signature: 'o', access: ACCESS_READ },
  },
  methods: {
    Activate: { inSignature: 'ii', outSignature: '' },
    SecondaryActivate: { inSignature: 'ii', outSignature: '' },
    Scroll: { inSignature: 'is', outSignature: '' },
    ContextMenu: { inSignature: 'ii', outSignature: '' },
  },
  signals: {
    NewIcon: { signature: '' },
    NewToolTip: { signature: '' },
    NewStatus: { signature: 's' },
  },
});

/* ------------------------------------------------------------------ */
/* Публичный интерфейс модуля                                          */
/* ------------------------------------------------------------------ */

/**
 * @returns {Promise<boolean>} удалось ли зарегистрировать индикатор
 */
async function start({ id, title, image, onActivate, menuItems }) {
  if (process.platform !== 'linux') return false;
  stopped = false;
  handlers.onActivate = onActivate || (() => {});

  try {
    bus = dbus.sessionBus();
    const serviceName = `org.freedesktop.StatusNotifierItem-${process.pid}-widget`;

    itemInterface = new StatusNotifierItem('org.kde.StatusNotifierItem', {
      id,
      title,
      pixmap: toArgbPixmap(image),
    });
    menuInterface = new DbusMenu('com.canonical.dbusmenu');
    menuInterface.setItems(menuItems || []);

    bus.export('/StatusNotifierItem', itemInterface);
    bus.export('/MenuBar', menuInterface);
    await bus.requestName(serviceName, 0);

    const watcherObject = await bus.getProxyObject(
      'org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher');
    const watcher = watcherObject.getInterface('org.kde.StatusNotifierWatcher');
    await watcher.RegisterStatusNotifierItem(serviceName);

    console.log('[tray] индикатор зарегистрирован (%s)', serviceName);
    return true;
  } catch (err) {
    console.warn('[tray] свой индикатор не поднялся: %s', err.message);
    stop();
    return false;
  }
}

function setMenu(items) {
  if (stopped || !menuInterface) return;
  menuInterface.setItems(items || []);
}

function setTooltip(text) {
  if (stopped || !itemInterface) return;
  itemInterface.setTooltip(text);
}

function stop() {
  if (stopped) return;
  stopped = true;
  try {
    // Сначала снимаем экспорт: иначе последний запрос оболочки уедет в наш
    // интерфейс и ответ на него улетит в уже закрытый сокет.
    if (bus) {
      if (itemInterface) bus.unexport('/StatusNotifierItem', itemInterface);
      if (menuInterface) bus.unexport('/MenuBar', menuInterface);
      bus.disconnect();
    }
  } catch (_) { /* уже отключён */ }
  bus = null;
  itemInterface = null;
  menuInterface = null;
}

module.exports = {
  start, setMenu, setTooltip, stop,
  isActive: () => Boolean(itemInterface) && !stopped,
};
