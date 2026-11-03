// Base class for pause-menu tabs. Subclasses implement build() (re-run after a language change) and optional
// show/hide/update/nav/activate/back/key/hints/onFocus hooks used by Menu.
export class Tab {
  constructor(menu, id) {
    this.menu = menu;
    this.game = menu.game;
    this.i18n = menu.i18n;
    this.id = id;
    this.dirty = true;
    this.el = document.createElement('div');
    this.el.className = 'tab';
    this.el.id = `${id}-tab`;
    menu.panelEl.appendChild(this.el);
  }

  t(k, p) { return this.i18n.t(k, p); }
  label() { return this.t(`menu.tab.${this.id}`); }
  available() { return true; }
  can(cap) { return this.game.can ? this.game.can(cap) : true; }
  emit(name, p = {}) { this.game.events.emit(name, p); }
  get ui() { return this.menu.ui; }

  ensure() {
    if (!this.dirty) return;
    this.dirty = false;
    const keep = this.menu.focus && this.el.contains(this.menu.focus) ? this.focusKey(this.menu.focus) : null;
    this.build();
    if (keep && this.menu.tab === this) {
      const el = this.el.querySelector(keep);
      if (el) { this.menu.focus = null; this.menu.setFocus(el, { scroll: false, silent: true }); }
    }
  }

  // CSS selector that finds "the same" element again after a rebuild
  focusKey(el) {
    for (const a of ['data-key', 'data-act', 'data-id', 'data-cat', 'data-lang', 'data-mode', 'data-v', 'data-i']) {
      const v = el.getAttribute(a);
      if (v !== null) return `[${a}="${CSS.escape(v)}"]`;
    }
    return null;
  }

  build() {}
}
