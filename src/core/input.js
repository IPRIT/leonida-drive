// Unified keyboard / mouse / gamepad state. Poll-based: call update() once per frame (done by the game loop).
// held(code) — key is down; pressed(code) — went down this frame; released(code) — went up this frame.
// Codes are KeyboardEvent.code values ('KeyW', 'Space', 'ShiftLeft'…) plus 'Mouse0'..'Mouse2'.
export class InputManager {
  constructor(dom) {
    this.dom = dom;
    this.down = new Set();
    this._pressed = new Set();
    this._released = new Set();
    this.framePressed = new Set();
    this.frameReleased = new Set();
    this.mouse = { dx: 0, dy: 0, wheel: 0, x: 0, y: 0, locked: false };
    this._acc = { dx: 0, dy: 0, wheel: 0 };
    this.gamepad = null; // { axes:[], buttons:[{pressed,value}] } snapshot
    this._gpPrev = [];
    this.gpPressed = new Set(); // button indices pressed this frame
    this.enabled = true;
    // Virtual gamepad (touch controls, src/mobile): an object with poll() -> { axes:number[4], buttons:{pressed,value}[17] }
    // or null when idle. Used whenever no physical pad is connected, so every gamepad-aware module works on touch.
    this.virtualPad = null;
    this.touch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0) && matchMedia?.('(pointer: coarse)').matches;
    const isTyping = (e) => e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
    // keys the browser would otherwise use (focus cycling, page scroll, quick find) belong to the game
    const GAME_KEYS = new Set(['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash', 'Quote', 'Backquote', 'F1', 'F3', 'PageUp', 'PageDown', 'Home', 'End']);
    // set by the game: may the pointer be captured right now (not in menus)
    this.shouldLock = () => false;
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (GAME_KEYS.has(e.code) && !e.ctrlKey && !e.metaKey) e.preventDefault();
      if (!this.down.has(e.code)) this._pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => { this.down.delete(e.code); this._released.add(e.code); });
    window.addEventListener('blur', () => { for (const c of this.down) this._released.add(c); this.down.clear(); });
    const btn = (b) => `Mouse${b}`;
    dom.addEventListener('mousedown', (e) => {
      this.down.add(btn(e.button));
      this._pressed.add(btn(e.button));
      // click into the game captures the cursor (Esc releases it and opens the menu)
      if (!this.touch && document.pointerLockElement !== dom && this.shouldLock()) this.lockPointer();
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'Tab' && !isTyping(e)) e.preventDefault(); });
    window.addEventListener('mouseup', (e) => { this.down.delete(btn(e.button)); this._released.add(btn(e.button)); });
    window.addEventListener('mousemove', (e) => {
      this._acc.dx += e.movementX || 0;
      this._acc.dy += e.movementY || 0;
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    });
    dom.addEventListener('wheel', (e) => { this._acc.wheel += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockchange', () => { this.mouse.locked = document.pointerLockElement === dom; });
  }

  update() {
    // swap + clear instead of allocating new sets every frame
    const fp = this.framePressed, fr = this.frameReleased;
    this.framePressed = this._pressed;
    this.frameReleased = this._released;
    fp.clear(); fr.clear();
    this._pressed = fp;
    this._released = fr;
    this.mouse.dx = this._acc.dx;
    this.mouse.dy = this._acc.dy;
    this.mouse.wheel = this._acc.wheel;
    this._acc.dx = this._acc.dy = this._acc.wheel = 0;
    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    if (pads) for (const p of pads) if (p && p.connected) { gp = p; break; }
    if (!gp && this.virtualPad) gp = this.virtualPad.poll();
    this.gpPressed.clear();
    if (gp) {
      const buttons = gp.buttons.map((b) => ({ pressed: b.pressed, value: b.value }));
      buttons.forEach((b, i) => { if (b.pressed && !this._gpPrev[i]) this.gpPressed.add(i); });
      this._gpPrev = buttons.map((b) => b.pressed);
      this.gamepad = { axes: [...gp.axes], buttons };
    } else {
      this.gamepad = null;
      this._gpPrev = [];
    }
  }

  held(code) { return this.enabled && this.down.has(code); }
  pressed(code) { return this.enabled && this.framePressed.has(code); }
  released(code) { return this.frameReleased.has(code); }
  gpHeld(i) { return !!this.gamepad?.buttons[i]?.pressed; }
  gpValue(i) { return this.gamepad?.buttons[i]?.value || 0; }
  gpPressedBtn(i) { return this.gpPressed.has(i); }
  axis(i, dead = 0.15) {
    const v = this.gamepad?.axes[i] || 0;
    return Math.abs(v) < dead ? 0 : (v - Math.sign(v) * dead) / (1 - dead);
  }

  lockPointer() {
    try { const p = this.dom.requestPointerLock?.(); p?.catch?.(() => {}); } catch { /* embedded contexts may refuse */ }
  }
  unlockPointer() { if (document.pointerLockElement === this.dom) document.exitPointerLock(); }
}

// standard gamepad button indices
export const GP = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
