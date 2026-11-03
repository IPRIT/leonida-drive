// Multiplayer UI: online counter + ping at the top centre (tap it on touch), the hold-Tab scoreboard (Scoreboard.js:
// nearby / top 10 / everyone online), the "Online" pause-menu tab (nickname purchases, toggles, stats), join/leave
// and combat feed (throttled), connection banners. Mounted into G's HUD slots when available, otherwise into its own
// overlay. DOM is only touched when a value changes; player names are always inserted as text.
import { PLAYER_COLORS, KICK, NOTICE, DMG } from '../shared/constants.js';
import { NAME_MAX, nameFormatError } from '../shared/nicknames.js';
import { makeT } from '../i18n.js';
import { createQueueCard } from './QueueCard.js';
import { Scoreboard } from './Scoreboard.js';

const CSS = `
.ldn-bar{display:flex;align-items:center;gap:8px;justify-content:center;font:500 14px var(--f-ui,'Oswald',sans-serif);color:#fff;
  text-shadow:var(--text-shadow,0 1px 2px #000);letter-spacing:.04em;pointer-events:none;margin-top:4px;white-space:nowrap}
.ldn-chip{display:flex;align-items:center;gap:7px;padding:3px 10px 3px 8px;border-radius:12px;background:rgba(8,8,12,.45)}
.ldn-dot{width:9px;height:9px;border-radius:50%;background:#55e07a;box-shadow:0 0 0 0 rgba(85,224,122,.7);animation:ldn-pulse 2s infinite}
.ldn-bar.reconnecting .ldn-dot,.ldn-bar.connecting .ldn-dot{background:#ffb020;animation-duration:.9s}
.ldn-bar.offline .ldn-dot,.ldn-bar.kicked .ldn-dot{background:#8a8f98;animation:none}
@keyframes ldn-pulse{0%{box-shadow:0 0 0 0 rgba(85,224,122,.6)}70%{box-shadow:0 0 0 7px rgba(85,224,122,0)}100%{box-shadow:0 0 0 0 rgba(85,224,122,0)}}
.ldn-ping{display:flex;align-items:flex-end;gap:2px;height:11px}
.ldn-ping i{display:block;width:3px;background:rgba(255,255,255,.3);border-radius:1px}
.ldn-ping i:nth-child(1){height:4px}.ldn-ping i:nth-child(2){height:7px}.ldn-ping i:nth-child(3){height:11px}
.ldn-ping.q3 i,.ldn-ping.q2 i:nth-child(-n+2),.ldn-ping.q1 i:nth-child(1){background:#7dff8c}
.ldn-ping.q1 i:nth-child(1){background:#ffb020}
.ldn-ms{font-size:12px;opacity:.75}
.ldn-hint{font:400 11px var(--f-ui,'Oswald','Arial Narrow',sans-serif);color:#fff;text-shadow:0 1px 2px #000;opacity:.6;text-align:center;margin-top:2px;transition:opacity .6s}
.ldn-hint .tc-only,body.is-mobile .ldn-hint .kb-only{display:none}body.is-mobile .ldn-hint .tc-only{display:inline}
.ldn-board{margin-top:6px;min-width:230px;padding:8px 10px;border-radius:6px;background:var(--ui-bg,rgba(8,8,12,.72));color:#fff;
  font:500 13px var(--f-ui,'Oswald',sans-serif);pointer-events:none;opacity:0;transform:translateX(12px);transition:opacity .18s,transform .18s}
.ldn-board.show{opacity:1;transform:none}
.ldn-board h4{margin:0 0 6px;font:400 13px var(--f-disp,'Russo One',sans-serif);letter-spacing:.06em;text-transform:uppercase;opacity:.85}
.ldn-row{display:grid;grid-template-columns:22px 12px 1fr auto;align-items:center;gap:6px;padding:2px 4px;border-radius:3px}
.ldn-row .r{opacity:.6;text-align:right}.ldn-row .d{width:8px;height:8px;border-radius:50%}
.ldn-row .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ldn-row .m{color:var(--money,#72d45b);font-family:var(--f-num,sans-serif);font-size:12px}
.ldn-row.me{background:rgba(255,63,164,.28)}.ldn-row.on .n:after{content:' •';color:#55e07a}
.ldn-sep{height:1px;background:rgba(255,255,255,.15);margin:4px 0}
.ldn-banner{position:fixed;left:50%;top:18%;transform:translateX(-50%);z-index:50;padding:14px 18px;border-radius:8px;background:rgba(8,8,12,.86);
  color:#fff;font:500 15px var(--f-ui,'Oswald',sans-serif);display:flex;gap:14px;align-items:center;box-shadow:0 8px 30px rgba(0,0,0,.5)}
.ldn-banner button,.ldn-tab button{font:500 14px var(--f-ui,'Oswald',sans-serif);padding:6px 14px;border:0;border-radius:4px;background:var(--pink,#ff3fa4);color:#fff;cursor:pointer}
.ldn-tab{padding:18px 22px;color:#fff;font:400 15px var(--f-ui,'Oswald',sans-serif);display:grid;grid-template-columns:minmax(260px,1fr) minmax(260px,1.2fr);gap:22px}
.ldn-tab .card{background:rgba(255,255,255,.05);border-radius:6px;padding:14px 16px}
.ldn-tab .nick{font:400 30px var(--f-disp,'Russo One',sans-serif);display:flex;align-items:center;gap:10px;margin:6px 0 12px}
.ldn-tab .nick i{width:14px;height:14px;border-radius:50%;display:inline-block}
.ldn-tab .kv{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.06)}
.ldn-tab .kv b{font-weight:500}.ldn-tab .muted{opacity:.6;font-size:13px}
.ldn-tab button.tog{background:rgba(255,255,255,.1);margin:6px 8px 0 0}.ldn-tab button.tog.on{background:var(--gta-green,#6ac259)}
.ldn-tab button:focus,.ldn-tab button.focus{outline:2px solid #fff}
.ldn-tab .ldn-row{font-size:15px;padding:4px 6px}.ldn-tab .ldn-row .m{font-size:14px}
.ldn-own{position:fixed;left:50%;top:6px;transform:translateX(-50%);z-index:20;pointer-events:none}
`;

const FEED_MAX_ONLINE = 30; // above this many players online, no join/leave cards at all
export class NetUI {
  constructor(game, net) {
    this.game = game;
    this.net = net;
    this.client = net.client;
    this.t = makeT(game);
    this.cache = {};
    this.feedQ = [];
    this.feedT = 0;
    this.hintT = 12;
    this._mountCss();
    this._build();
    this._off = [
      this.client.on('status', () => this._status()),
      this.client.on('queue', () => this._queueCard()),
      this.client.on('global', () => this._dirtyBoard()),
      this.client.on('event', (e) => this._joinLeave(e)),
      this.client.on('kick', (c) => this._kick(c)),
      this.client.on('notice', (n) => this._notice(n)),
      this.client.on('welcome', (w) => this._welcome(w)),
      this.client.on('nick', (r) => {
        if (r.result === 0) { this.nickWait = performance.now() + r.cooldownS * 1000; this._feed(this.t('nickChanged', { name: this.client.displayName(this.client.welcome || {}) }), 'player', 4); }
        else if (r.result === 1) this.nickWait = performance.now() + r.cooldownS * 1000;
        this._dirtyBoard(); this.tab?.refresh();
      }),
      this.client.on('rank', () => this._dirtyBoard()),
      this.client.on('correction', () => this._feed(this.t('corrected'), 'info')),
      this.client.on('hit', (h) => { if (h.destroyed) this._feed(this.t('destroyed', { name: this._nameOf(h.victim) }), 'player', 3); else this._feed(this.t('hit', { name: this._nameOf(h.victim) }), 'player', 2); }),
      this.client.on('damage', (d) => {
        const name = this._nameOf(d.attacker);
        if (d.kind === DMG.CRUSH) this._feed(this.t('crushedBy', { name }), 'player', 4);
        else if (d.destroyed) this._feed(this.t('destroyedBy', { name }), 'player', 4);
        else this._feed(this.t('shotBy', { name }), 'player', 2);
      }),
    ];
    this.board = new Scoreboard(this);
    this.el.bar.addEventListener('click', () => this.board.toggle()); // touch: tap the online pill
    this._addTab();
    this._status();
  }

  /** The top-10 board is served on request: call every frame while a view shows it (re-asks when it changed). */
  wantBoard() {
    const c = this.client, g = c.global, now = performance.now();
    if (!c.online) return;
    const stale = !g?.boardAt || (g.boardVer !== undefined && g.boardVer !== c.boardVer);
    if (stale && now - (this.boardAsk || 0) > 1500) { this.boardAsk = now; c.requestBoard(); }
  }

  _nameOf(netId) { const e = this.client.store.byId.get(netId); return e ? this.client.displayName(e) : '?'; }

  hintSeen() { this.hintT = 0; this.el.hint.style.opacity = '0'; }

  _mountCss() {
    if (document.getElementById('ldn-css')) return;
    const s = document.createElement('style');
    s.id = 'ldn-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  _build() {
    const bar = document.createElement('div');
    bar.className = 'ldn-bar connecting';
    bar.innerHTML = '<div class="ldn-chip"><span class="ldn-dot"></span><span class="ldn-count"></span><span class="ldn-ping q3"><i></i><i></i><i></i></span><span class="ldn-ms"></span></div>';
    const hint = document.createElement('div');
    hint.className = 'ldn-hint';
    // keyboard / touch wording side by side; body.is-mobile (src/mobile/mobile.css) picks one, also after a late
    // switch to touch on hybrid devices. Strings go in as text.
    const kb = document.createElement('span'), tc = document.createElement('span');
    kb.className = 'kb-only'; tc.className = 'tc-only';
    kb.textContent = this.t('holdTab');
    const tap = this.game.i18n?.t?.('mobile.tapPlayers', { default: 'Tap — players' });
    tc.textContent = tap && tap !== 'mobile.tapPlayers' ? tap : 'Tap — players';
    hint.append(kb, tc);
    const top = document.createElement('div');
    top.append(bar, hint);
    this.el = { top, bar, hint, count: bar.querySelector('.ldn-count'), ping: bar.querySelector('.ldn-ping'), ms: bar.querySelector('.ldn-ms') };
    const hud = this.game.ui?.hud;
    this.unmount = [];
    try {
      if (hud?.mount) {
        this.unmount.push(hud.mount('top-center', top));
      } else throw new Error('no hud slots');
    } catch {
      // labs / older UI: our own overlay
      const own = document.createElement('div');
      own.className = 'ldn-own';
      own.append(top);
      document.body.appendChild(own);
      this.unmount.push(() => own.remove());
    }
  }

  // ---------------- top bar ----------------
  // waiting in line after a reconnect to a full server (the game goes on offline): a compact card with the way out.
  // Before the game starts the start screen shows its own card.
  _queueCard() {
    const c = this.client, show = c.status === 'queued' && this.game.frame > 0 && !!c.queue;
    if (!show) { this.qcard?.remove(); this.qcard = null; return; }
    if (!this.qcard) {
      this.qcard = createQueueCard(document.body, {
        t: this.t, compact: true, num: (n) => this._num(n),
        onSingle: () => (this.game.switchMode ? this.game.switchMode('single') : null),
        onCancel: () => { this.net.leaveQueue(); this._queueCard(); },
      });
    }
    this.qcard.update(c.queue);
  }

  _status() {
    const s = this.client.status;
    this._queueCard();
    const bar = this.el.bar;
    bar.className = `ldn-bar ${s}`;
    this._setText('count', this._countText());
    if (s !== 'online') { this.el.ms.textContent = ''; this.cache.ms = ''; }
    this.el.ping.style.display = s === 'online' ? '' : 'none'; // no signal bars while offline / reconnecting
    if (s === 'offline' && !this._offlineShown && !this.client.protoMismatch) { this._offlineShown = true; this._feed(this.t('offlineHint'), 'info', 7); }
    // versions differ: the pill becomes a reload button (the game keeps playing offline meanwhile)
    // another version: the pill reloads the page; left the line: the pill joins it again (at the back)
    const v = s === 'offline' && (this.client.protoMismatch ? 'reload' : this.client.cancelled ? 'rejoin' : '');
    if (this._verBtn !== v) {
      this._verBtn = v;
      bar.title = v === 'reload' ? this.t('kickProtocol') : v === 'rejoin' ? this.t('reconnecting') : '';
      bar.style.cursor = v ? 'pointer' : '';
      bar.style.pointerEvents = v ? 'auto' : '';
      bar.onclick = v === 'reload' ? () => location.reload() : v === 'rejoin' ? () => this.net.rejoin() : null;
    }
    if (s === 'online') this._offlineShown = false;
  }

  _countText() {
    const s = this.client.status;
    if (s === 'online') {
      const n = this.client.global?.online ?? 1;
      return this.t(n === 1 ? 'online_one' : 'online', { count: this._num(n) });
    }
    if (s === 'offline') return this.t(this.client.protoMismatch ? 'offlineVersion' : this.client.cancelled ? 'offline' : this.client.serverFull ? 'kickFull' : 'offlineRetry');
    if (s === 'queued') return this.t('queuePill', { pos: this._num(this.client.queue?.position ?? 0) });
    return this.t(s === 'kicked' || s === 'idle' ? 'offline' : s);
  }

  _num(n) { return this.game.i18n?.number?.(n) ?? Math.round(n).toLocaleString(); }
  _money(n) { return this.game.i18n?.money?.(n) ?? `$${Math.round(n).toLocaleString()}`; }

  _setText(k, v) { if (this.cache[k] !== v) { this.cache[k] = v; this.el[k].textContent = v; } }

  // ---------------- leaderboard (pause-menu tab; the hold-Tab overlay is Scoreboard.js) ----------------
  toggleBoard(on = !this.board.open) { if (on) this.board.show('tap'); else this.board.hide(); }

  _dirtyBoard() { this.boardDirty = true; }

  _rows() {
    const g = this.client.global, me = this.client.welcome?.netId ?? this.client.lastWelcome?.netId;
    const top = g?.top || [];
    const rows = top.map((t, i) => ({ rank: i + 1, nick: this.client.displayName(t), color: PLAYER_COLORS[t.color % PLAYER_COLORS.length], money: t.money, me: t.netId === me, on: t.netId > 0 }));
    const r = this.net.economy.rank;
    const mine = rows.some((x) => x.me) ? null : r && this.client.welcome ? {
      rank: r.rank, nick: this.client.displayName(this.client.welcome), color: PLAYER_COLORS[this.client.welcome.color % PLAYER_COLORS.length],
      money: this.net.economy.worth || this.net.economy.money, me: true, on: true,
    } : null;
    return { rows, mine };
  }

  _rowHtml(x) {
    return `<div class="ldn-row${x.me ? ' me' : ''}${x.on && !x.me ? ' on' : ''}"><span class="r">${x.rank}</span><span class="d" style="background:${x.color}"></span><span class="n">${esc(x.me ? `${x.nick} (${this.t('you')})` : x.nick)}</span><span class="m">${esc(this._money(x.money))}</span></div>`;
  }

  _renderBoard(target, withTitle = true) {
    if (!target) return;
    const { rows, mine } = this._rows();
    let html = withTitle ? `<h4>${esc(this.t('leaderboard'))} · ${esc(this.t('netWorth'))}</h4>` : '';
    html += rows.map((x) => this._rowHtml(x)).join('');
    if (mine) html += `<div class="ldn-sep"></div>${this._rowHtml(mine)}`;
    if (target.__html !== html) { target.__html = html; target.innerHTML = html; }
  }

  // ---------------- feed / banners ----------------
  _feed(text, kind = 'player', seconds = 4, silent = false) {
    const ui = this.game.ui;
    if (ui?.feed) ui.feed({ kind, text, seconds, silent });
    else ui?.notify?.(text, seconds, silent);
  }

  _joinLeave(e) {
    if (e.netId === this.client.welcome?.netId) return;
    if (this.feedQ.length < 64) this.feedQ.push(e); // only counts matter beyond a few
    else this.feedDrop = (this.feedDrop || 0) + (e.kind === 1 ? 1 : 0);
  }

  // join/leave cards are silent (no chime) and only shown on a quiet server: with many players online the stream of
  // arrivals and departures is noise, so it's dropped entirely
  _flushFeed(dt) {
    this.feedT -= dt;
    if (this.feedT > 0 || !this.feedQ.length) return;
    const busy = (this.client.global?.online ?? 0) > FEED_MAX_ONLINE;
    let joins = 0, leaves = 0, j0 = null, l0 = null;
    for (const e of this.feedQ) { if (e.kind === 1) { joins++; j0 ??= e; } else if (e.kind === 2) { leaves++; l0 ??= e; } }
    joins += this.feedDrop || 0;
    this.feedQ.length = 0;
    this.feedDrop = 0;
    this.feedT = 5; // at most one card every 5 s
    if (busy) return;
    if (joins > 1) this._feed(this.t('joinedMany', { count: joins }), 'player', 3, true);
    else if (joins === 1) this._feed(this.t('joined', { name: this.client.displayName(j0) }), 'player', 3, true);
    if (leaves === 1 && !joins) this._feed(this.t('left', { name: this.client.displayName(l0) }), 'player', 3, true);
  }

  _welcome(w) {
    const name = this.client.displayName(w);
    if (w.afterOffline) this._feed(this.t('backOnline', { name }), 'player', 7);
    else if (w.first) this._feed(this.t(w.restore ? 'welcomeBack' : 'welcome', { name }), 'player', 5);
    this._hideBanner();
    this._dirtyBoard();
    this.tab?.refresh();
  }

  _notice(n) {
    if (n.code === NOTICE.CLAIMS_FROZEN) this._feed(this.t('frozen'), 'bank', 8);
    else if (n.code === NOTICE.CLAIMS_RESTORED) this._feed(this.t('restored'), 'bank', 5);
    else if (n.code === NOTICE.HOSPITAL_FEE) this._feed(this.t('hospital', { amount: this._money(n.param) }), 'bank', 5);
  }

  _kick(code) {
    if (code === KICK.DUPLICATE) this._banner(this.t('kickDuplicate'), this.t('playHere'), () => { this._hideBanner(); this.client.retry(); });
    else if (code === KICK.PROTOCOL) { if (this.client.protoMismatch === 1) this._feed(this.t('versionOffline'), 'info', 10); } // offline pill + reload
    else if (code === KICK.BANNED) this._banner(this.t('kickBanned'));
    else if (code === KICK.FULL) this._feed(this.t('queueFull'), 'info', 8);
    else if (code === KICK.SHUTDOWN) this._feed(this.t('kickShutdown'), 'info');
  }

  _banner(text, button, fn) {
    this._hideBanner();
    const b = document.createElement('div');
    b.className = 'ldn-banner';
    b.innerHTML = `<span>${esc(text)}</span>${button ? `<button>${esc(button)}</button>` : ''}`;
    if (button) b.querySelector('button').onclick = fn;
    document.body.appendChild(b);
    this.bannerEl = b;
  }
  _hideBanner() { this.bannerEl?.remove(); this.bannerEl = null; }

  // ---------------- pause menu tab ----------------
  _addTab() {
    const menu = this.game.ui?.menu;
    if (!menu?.addTab) return;
    const self = this;
    try {
      menu.addTab({
        id: 'online', icon: 'globe', labelKey: 'net.tab', label: this.t('tab'), after: 'player',
        create(container) { self.tab = new OnlineTab(self, container); return self.tab; },
      });
    } catch (e) { console.warn('[net] menu tab', e); }
  }

  // ---------------- per frame ----------------
  update(dt) {
    const c = this.client;
    this._setText('count', this._countText());
    if (c.status === 'online') {
      const rtt = Math.round(c.clock.rtt || 0);
      const q = rtt < 90 ? 3 : rtt < 180 ? 2 : 1;
      if (this.cache.q !== q) { this.cache.q = q; this.el.ping.className = `ldn-ping q${q}`; }
      this._setText('ms', rtt ? this.t('ping', { ms: rtt }) : '');
    }
    if (this.hintT > 0) { this.hintT -= dt; if (this.hintT <= 0) this.el.hint.style.opacity = '0'; }
    this.board.update(dt);
    this._flushFeed(dt);
  }

  dispose() {
    this.qcard?.remove();
    this.board.dispose();
    for (const off of this._off) off();
    for (const u of this.unmount) u?.();
    this._hideBanner();
    try { this.game.ui?.menu?.removeTab?.('online'); } catch { /* menu gone */ }
  }
}

class OnlineTab {
  constructor(ui, container) {
    this.ui = ui;
    this.el = document.createElement('div');
    this.el.className = 'ldn-tab';
    container.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act, g = ui.game;
      if (act === 'reroll') this._nick(ui.net.rerollNick());
      else if (act === 'custom') {
        const name = this.el.querySelector('input[data-nick]')?.value.trim() || '';
        const bad = nameFormatError(name);
        if (bad) { this.err = ui.t('nickErr_format'); this.refresh(); return; }
        this._nick(ui.net.setNickname(name));
      } else if (act === 'players') g.applySetting('mpShowPlayers', !(g.settings.mpShowPlayers ?? true));
      else if (act === 'tags') g.applySetting('mpNametags', !(g.settings.mpNametags ?? true));
      g.events?.emit('ui:click', {});
      this.refresh();
    });
    this.refresh();
  }

  async _nick(p) {
    this.busy = true; this.err = ''; this.refresh();
    const r = await p;
    this.busy = false;
    this.err = r.ok ? '' : this.ui.t(`nickErr_${r.reason || 'busy'}`);
    if (r.ok) { const inp = this.el.querySelector('input[data-nick]'); if (inp) inp.value = ''; }
    this._html = null;
    this.refresh();
  }

  refresh() {
    const ui = this.ui, t = ui.t, c = ui.client, g = ui.game, w = c.welcome || c.lastWelcome;
    const wait = Math.max(0, Math.ceil(((ui.nickWait || 0) - performance.now()) / 1000));
    const prices = ui.net.nickPrices, money = ui.net.economy.money;
    const off = c.status !== 'online' || this.busy || wait > 0;
    const rank = ui.net.economy.rank;
    const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
    const showP = g.settings.mpShowPlayers ?? true, showT = g.settings.mpNametags ?? true;
    const left = `<div class="card">
        <div class="muted">${esc(t('nickname'))}</div>
        <div class="nick"><i style="background:${w ? PLAYER_COLORS[w.color % PLAYER_COLORS.length] : '#888'}"></i>${esc(w ? c.displayName(w) : '—')}</div>
        <button data-act="reroll" data-nav ${off || money < prices.reroll ? 'disabled' : ''}>${esc(wait ? t('rerollWait', { s: wait }) : t('nickReroll', { price: ui._money(prices.reroll) }))}</button>
        <div style="margin-top:12px" class="muted">${esc(t('nickCustom'))}</div>
        <div style="display:flex;gap:8px;margin-top:6px">
          <input data-nick maxlength="${NAME_MAX}" spellcheck="false" autocomplete="off" placeholder="${esc(t('nickPlaceholder'))}"
            style="flex:1;min-width:0;font:400 15px var(--f-ui,'Oswald',sans-serif);padding:6px 10px;border-radius:4px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.35);color:#fff">
          <button data-act="custom" data-nav ${off || money < prices.custom ? 'disabled' : ''}>${esc(t('nickBuy', { price: ui._money(prices.custom) }))}</button>
        </div>
        ${this.err ? `<div class="muted" style="color:#ff8080;margin-top:6px">${esc(this.err)}</div>` : ''}
        <div style="margin-top:16px">
          ${kv(t('status'), ui._countText())}
          ${kv(t('players'), c.global ? ui._num(c.global.online) : '—')}
          ${kv(t('netWorth'), ui._money(ui.net.economy.worth || ui.net.economy.money))}
          <div class="muted" data-worth-breakdown style="font-size:13px;margin:6px 0 10px">${esc(t('worthBreakdown', { cash: ui._money(ui.net.economy.money), vehicles: ui._money(Math.max(0, (ui.net.economy.worth || ui.net.economy.money) - ui.net.economy.money)) }))}</div>
          ${rank ? kv(t('leaderboard'), t('yourRank', { rank: ui._num(rank.rank), total: ui._num(rank.total) })) : ''}
          ${kv(t('server'), `${hostOf(c.url)} · ${c.clock.rtt ? t('ping', { ms: Math.round(c.clock.rtt) }) : '—'}`)}
        </div>
        <div style="margin-top:12px">
          <button class="tog ${showP ? 'on' : ''}" data-act="players" data-nav>${esc(t('showPlayers'))}</button>
          <button class="tog ${showT ? 'on' : ''}" data-act="tags" data-nav>${esc(t('showTags'))}</button>
        </div>
      </div>`;
    const right = `<div class="card"><h4 style="margin:0 0 10px;font:400 15px var(--f-disp,'Russo One',sans-serif)">${esc(t('leaderboard'))} · ${esc(t('netWorth'))}</h4><div class="list"></div></div>`;
    const html = left + right;
    if (this._html !== html) {
      // keep what is being typed in the nickname field across re-renders
      const inp = this.el.querySelector('input[data-nick]');
      const val = inp?.value ?? '', focused = !!inp && document.activeElement === inp, a = inp?.selectionStart, b = inp?.selectionEnd;
      this._html = html;
      this.el.innerHTML = html;
      const n = this.el.querySelector('input[data-nick]');
      if (n) { n.value = val; if (focused) { n.focus(); try { n.setSelectionRange(a, b); } catch { /* ignore */ } } }
    }
    ui._renderBoard(this.el.querySelector('.list'), false);
  }

  show() { this.ui.wantBoard(); this.refresh(); }
  hide() {}
  update() { this.ui.wantBoard(); this._t = (this._t || 0) + 1; if (this._t % 30 === 0) this.refresh(); }
  destroy() { this.el.remove(); this.ui.tab = null; }
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function hostOf(u) { try { return new URL(u).host; } catch { return u; } }
