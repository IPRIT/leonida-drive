import './debug.css';
import { FrameHistory, diagnostics } from './metrics.js';
import { LinkEmulator } from './LinkEmulator.js';
import { FEATURE } from '../net/shared/extensions.js';

const fmt = (n, digits = 1) => Number.isFinite(n) ? n.toFixed(digits) : '—';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function installDebug(menu) {
  if (menu.byId.has('debug')) { menu.select('debug'); return; }
  menu.addTab({ id: 'debug', label: 'Debug', icon: 'wrench', after: 'about', create(el) { return new DebugPanel(menu, el); } });
  menu.select('debug');
}

class DebugPanel {
  constructor(menu, el) {
    this.menu = menu; this.g = menu.game; this.el = el; this.history = new FrameHistory();
    this.visible = false; this.hudOn = false; this.section = 'perf'; this.crossing = 0;
    this.ru = this.g.i18n?.lang === 'ru' || this.g.i18n?.locale === 'ru';
    this.t = (ru, en) => this.ru ? ru : en;
    this.hud = document.createElement('div'); this.hud.className = 'ld-debug-hud'; this.hud.hidden = true; document.body.append(this.hud);
    this.module = { update: (dt) => this.updateFrame(dt) };
    this.originalEffects = { ...this.g.render.effects };
    this.build();
    this.onChange = () => { this.ru = this.g.i18n?.lang === 'ru' || this.g.i18n?.locale === 'ru'; this.build(); };
    this.offLang = this.g.i18n?.onChange?.(this.onChange);
  }

  build() {
    const t = this.t, b = (act, label, cls = '') => `<button data-nav data-d="${act}" class="${act.startsWith('tab:') || act.startsWith('fx:') ? 'chip' : 'mbtn'} ${cls}">${esc(label)}</button>`;
    const kv = (key, label) => `<div class="row d-kv"><span>${esc(label)}</span><b data-m="${key}">—</b></div>`;
    const metric = (key, label) => `<div class="d-metric"><small>${esc(label)}</small><strong class="d-value" data-m="${key}">—</strong></div>`;
    this.el.innerHTML = `<div class="ld-debug">
      <div class="d-head"><div><div class="d-kicker">${t('ИНСТРУМЕНТЫ РАЗРАБОТЧИКА','DEVELOPER TOOLS')}</div><h2>${t('Диагностика','Diagnostics')}</h2></div><div class="d-actions"><span class="d-badge">${this.g.online ? 'ONLINE' : 'SANDBOX'}</span>${b('hud', t('Показатели поверх игры','In-game metrics'))}${b('export', t('Скачать отчёт','Export report'))}${b('disable', t('Выключить','Disable'))}</div></div>
      <div class="d-tabs">${[['perf',t('Производительность','Performance')],['network',t('Сеть','Network')],['world',t('Мир и физика','World & physics')],['admin',t('Админка','Admin')]].map(([id,name])=>b('tab:'+id,name)).join('')}</div>
      <div class="d-grid">${metric('fps','FPS')}${metric('cpu','CPU · ms')}${metric('gpu','GPU · ms')}${metric('ping','RTT · ms')}</div>
      <section class="d-section" data-section="perf"><div class="d-columns"><div class="d-card"><h3 class="sec">${t('Время кадра','Frame time')}</h3><canvas width="720" height="180" aria-label="Frame time graph"></canvas><div class="d-legend"><span data-m="percentiles"></span><span>60 FPS = 16.7 ms</span></div><p class="d-note">${t('В меню фон обновляется реже. Для замеров в движении включите показатели поверх игры.','The menu redraws its background less often. Enable in-game metrics to measure driving.')}</p><div class="d-fx">${['ao','ssr','bloom','grain','fog'].map((k)=>b('fx:'+k,k.toUpperCase())).join('')}${b('restoreFx',t('Вернуть эффекты','Restore effects'))}</div></div><div class="d-card"><h3 class="sec">${t('Рендер и загрузка','Rendering & loading')}</h3>${kv('resolution',t('Разрешение','Resolution'))}${kv('aa',t('Сглаживание','Anti-aliasing'))}${kv('calls','Draw calls')}${kv('triangles',t('Треугольники','Triangles'))}${kv('shaders',t('Шейдеры','Shaders'))}${kv('workers',t('Дороги: worker / главный поток','Roads: worker / main thread'))}</div></div></section>
      <section class="d-section" data-section="network" hidden><div class="d-columns"><div class="d-card"><h3 class="sec">${t('Проверка плохой связи','Connection stress test')}</h3><p>${t('Задержка и пропуски обновлений движения. Управление машиной остаётся локальным.','Delay and loss of movement updates. Your vehicle controls remain local.')}</p><div class="d-actions">${b('net:normal',t('Обычная','Normal'))}${b('net:poor','500 ms · 5%')}${b('net:severe','1500 ms · 15%')}${b('net:outage',t('Нет обновлений','No updates'))}</div><p class="d-note">${t('Это добавленная задержка туда-обратно. RTT выше показывает реальный ping. Покупки и вход в админку не затрагиваются.','This is added round-trip latency. RTT above shows real ping. Purchases and admin login are unaffected.')}</p><p data-m="simulation"></p></div><div class="d-card">${kv('connection',t('Соединение','Connection'))}${kv('jitter','Jitter · ms')}${kv('buffer',t('Буфер интерполяции','Interpolation buffer'))}${kv('bandwidth',t('Входящий поток','Download'))}${kv('queue',t('Очередь отправки','Send queue'))}${kv('players',t('В 3D / на карте','In 3D / on map'))}${kv('corrections',t('Коррекции позиции','Position corrections'))}</div></div></section>
      <section class="d-section" data-section="world" hidden><div class="d-columns"><div class="d-card"><h3 class="sec">${t('Многоуровневые пересечения','Grade-separated crossings')}</h3><select class="d-full" aria-label="Crossing" data-crossing>${(this.g.roads?.overpasses || []).map((o,i)=>`<option value="${i}">#${i+1} · X ${Math.round(o.x)} / Z ${Math.round(o.z)}</option>`).join('')}</select><div class="d-cross" data-m="crossing"></div><div class="d-actions">${b('view:overview',t('Общий вид','Overview'))}${b('view:under',t('Под мостом','Underpass'))}${b('view:deck',t('На мосту','Bridge deck'))}${b('driver',t('Вернуться к машине','Back to vehicle'))}</div><p class="d-note">${t('Меняется только камера. Машина остаётся на месте.','Only the camera moves. Your vehicle stays in place.')}</p><div class="d-actions">${b('day',t('Дневной свет','Daylight'))}${b('colliders',t('Показать коллизии','Show colliders'))}</div></div><div class="d-card"><h3 class="sec">${t('Текущий транспорт','Current vehicle')}</h3>${kv('model',t('Модель','Model'))}${kv('position','X / Y / Z')}${kv('speed',t('Скорость · км/ч','Speed · km/h'))}${kv('health',t('Прочность','Health'))}${kv('crossings',t('Пересечения','Crossings'))}</div></div></section>
      <section class="d-section" data-section="admin" hidden><div class="d-columns"><div class="d-card"><h3 class="sec">${t('Доступ администратора','Administrator access')}</h3><p>${t('Деньги и предметы выдаются вашему профилю. Перемещения доступны для игроков в сети. Вход действует 15 минут, до переподключения.','Money and items apply to your profile. Travel actions work with online players. Access lasts 15 minutes, until reconnect.')}</p><form data-admin-form><label for="ld-admin-password">${t('Пароль','Password')}</label><div class="d-field"><input id="ld-admin-password" type="password" autocomplete="off" maxlength="128" required><button class="mbtn primary" type="submit">${t('Войти','Sign in')}</button></div></form><div class="d-status" role="status" aria-live="polite" data-admin-status></div><div data-admin-tools hidden><label for="ld-admin-amount">${t('Начислить себе','Credit my balance')} · $</label><div class="d-field"><input id="ld-admin-amount" type="number" min="1" max="100000000" step="1000" value="1000000">${b('credit',t('Начислить','Credit'))}</div><div class="d-actions" style="margin-top:16px">${b('unlock',t('Открыть весь гараж и одежду','Unlock garage & wardrobe'))}${b('thaw',t('Снять блокировку покупок','Unfreeze purchases'))}${b('logout',t('Выйти','Sign out'))}</div>
      <h3 class="sec">${t('Перемещение игроков','Player travel')}</h3><label for="ld-admin-player">${t('Игрок в сети','Online player')}</label><select id="ld-admin-player" class="d-full" data-nav><option value="">${t('Обновите список','Refresh the list')}</option></select><div class="d-actions d-player-pages">${b('players:refresh',t('Обновить','Refresh'))}${b('players:prev',t('Назад','Previous'))}${b('players:next',t('Далее','Next'))}</div><p class="d-note" data-players-status></p><div class="d-actions">${b('travel_to',t('Переместиться к игроку','Travel to player'),'primary')}${b('bring',t('Переместить к себе','Bring player to me'))}</div><p class="d-note">${t('Транспорт перемещается вместе с игроком. Самолёты и вертолёты появляются в воздухе рядом с целью.','Players travel with their vehicles. Planes and helicopters arrive in the air near the destination.')}</p></div></div><div class="d-card"><h3 class="sec">${t('Мой профиль','My profile')}</h3>${kv('balance',t('Баланс','Balance'))}${kv('access',t('Доступ','Access'))}<p class="d-note">${t('Начисления и открытые предметы сохраняются на сервере.','Credits and unlocked items are saved on the server.')}</p></div></div></section>
    </div>`;
    this.values = new Map([...this.el.querySelectorAll('[data-m]')].map((e)=>[e.dataset.m,e]));
    this.el.onclick = (e) => { const b=e.target.closest('[data-d]'); if (b) void this.action(b.dataset.d); };
    this.el.querySelector('[data-crossing]').value = this.crossing;
    this.el.querySelector('[data-crossing]').onchange = (e) => { this.crossing = +e.target.value; this.refresh(); };
    this.el.querySelector('#ld-admin-player').onchange = () => this.refresh();
    this.el.querySelector('[data-admin-form]').onsubmit = (e) => { e.preventDefault(); void this.action('login'); };
    this.setSection(this.section); this.refresh();
  }

  show() { this.visible = true; this.syncLoop(); this.refresh(); }
  hide() { this.visible = false; const p=this.el.querySelector('[type=password]'); if(p) p.value=''; this.syncLoop(); }
  update(dt) { if (this.g.paused && this.visible) this.updateFrame(dt); }
  syncLoop() {
    const needed = this.visible || this.hudOn || this.colliders;
    if (needed && !this.running) { this.running=true; this.lastFrame=0; this.g.register(this.module,1000); }
    if (!needed && this.running) { this.running=false; this.g.unregister(this.module); }
  }
  setSection(id) {
    this.section=id;
    for (const s of this.el.querySelectorAll('[data-section]')) s.hidden=s.dataset.section!==id;
    for (const b of this.el.querySelectorAll('[data-d^="tab:"]')) b.setAttribute('aria-pressed',String(b.dataset.d==='tab:'+id));
  }
  set(key,value) { const e=this.values.get(key); if(e && e.textContent!==String(value)) e.textContent=value; }
  refresh() {
    const d=diagnostics(this.g,this.history),r=d.render,n=d.network,v=d.vehicle,t=this.t,c=this.g.net?.client;
    if (d.frames.mean > 0) r.fps = 1000 / d.frames.mean;
    this.latest=d;
    this.set('fps',fmt(r.fps,0));this.set('cpu',d.paused?'—':fmt(r.cpuMs));this.set('gpu',d.paused?'—':fmt(r.gpuMs));this.set('ping',n?fmt(n.rtt,0):'—');
    this.set('resolution',`${r.width} × ${r.height} · ${fmt(r.appliedScale*100,0)}%`);this.set('aa',`${r.antialiasing} / ${r.samples}× MSAA`);
    this.set('calls',r.drawCalls);this.set('triangles',Number(r.triangles).toLocaleString());this.set('shaders',`${r.programs} / +${r.compiles}`);
    this.set('workers',`${fmt(d.world.roadWorkerMs)} / ${fmt(d.world.roadHydrateMs)} ms`);
    this.set('percentiles',`P50 ${fmt(d.frames.p50)} · P95 ${fmt(d.frames.p95)} · P99 ${fmt(d.frames.p99)} ms`);
    this.set('connection',n?.status||'offline');this.set('jitter',fmt(n?.jitter));this.set('buffer',`${fmt(n?.delay,0)} ms`);this.set('bandwidth',`${fmt(n?.kbps)} kbit/s`);
    this.set('queue',`${n?.bufferedBytes||0} B`);this.set('players',`${n?.remote3d||0} / ${n?.mapTracks||0}`);this.set('corrections',n?.corrections||0);
    this.set('simulation',c?.link?.active?`${t('Тест связи включён','Connection test active')}: ${c.link.profile} · ${t('пропущено','dropped')} ${c.link.dropped}`:t('Искусственные помехи выключены.','Artificial impairment is off.'));
    this.set('model',v.model);this.set('position',`${fmt(v.x)} / ${fmt(v.y)} / ${fmt(v.z)}`);this.set('speed',fmt(v.speed*3.6,0));this.set('health',v.health===null?'—':fmt(v.health,2));this.set('crossings',d.world.crossings);
    const o=this.g.roads?.overpasses?.[this.crossing];
    if(o) { const y0=this.g.roads.nodeY[o.ni],y1=this.g.roads.nodeY[o.nj];this.set('crossing',`#${this.crossing+1} · ${t('Уровни','Deck levels')} ${fmt(y0,2)} / ${fmt(y1,2)} m · Δ ${fmt(Math.abs(y1-y0),2)} m`); }
    this.set('balance',`$${Math.round(this.g.economy?.money??c?.welcome?.money??0).toLocaleString()}`);
    const left=Math.max(0,Math.ceil(((c?.adminUntil||0)-performance.now())/1000));
    this.set('access',left?`${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`:t('Закрыт','Locked'));
    this.el.querySelector('[data-admin-form]').hidden=left>0;this.el.querySelector('[data-admin-tools]').hidden=left<=0;
    if(!c?.online || !(c.features&FEATURE.ADMIN)) this.adminStatus(t('Для входа нужен сервер с включённой админкой.','Connect to a server with admin access enabled.'));
    for(const b of this.el.querySelectorAll('[data-d^="fx:"]')) b.setAttribute('aria-pressed',String(!!this.g.render.effects[b.dataset.d.slice(3)]));
    this.el.querySelector('[data-d=hud]').setAttribute('aria-pressed',String(this.hudOn));
    this.el.querySelector('[data-d=colliders]').setAttribute('aria-pressed',String(!!this.colliders));
    this.el.querySelector('[data-d=day]').disabled=!this.g.can('time');
    const travelReady = c?.online && left>0 && !!(c.features&FEATURE.ADMIN_TRAVEL);
    const selected = Number(this.el.querySelector('#ld-admin-player').value);
    for(const op of ['travel_to','bring'])this.el.querySelector(`[data-d=${op}]`).disabled=!travelReady||!selected||this.busy;
    for(const op of ['refresh','prev','next'])this.el.querySelector(`[data-d="players:${op}"]`).disabled=!travelReady||this.playersLoading||this.busy||performance.now()<(this.playersAt||0)+1000||(op==='prev'&&!(this.playerPage>0))||(op==='next'&&!this.playersNext);
    if(left>0 && !(c?.features&FEATURE.ADMIN_TRAVEL))this.el.querySelector('[data-players-status]').textContent=t('Для перемещения обновите игру и сервер.','Update the game and server to use player travel.');

    if(this.hudOn) this.hud.textContent=`LEONIDA / ${d.mode}\n${fmt(r.fps,0)} FPS   CPU ${fmt(r.cpuMs)}   GPU ${fmt(r.gpuMs)} ms\nP95 ${fmt(d.frames.p95)} ms   RTT ${fmt(n?.rtt,0)} ms\nX ${fmt(v.x)}  Y ${fmt(v.y)}  Z ${fmt(v.z)}\n${n?.remote3d||0} 3D / ${n?.mapTracks||0} MAP${c?.link?.active?'\nNETWORK TEST: '+c.link.profile:''}`;
  }
  updateFrame(dt) {
    const now=performance.now();
    if(document.hidden){this.lastFrame=0;return;}
    if(this.lastFrame)this.history.push(now-this.lastFrame);this.lastFrame=now;
    this.elapsed=(this.elapsed||0)+dt;
    if(this.elapsed<.25)return;this.elapsed=0;
    this.refresh();if(this.visible)this.drawGraph();if(this.colliders)this.drawColliders();
  }
  drawGraph() {
    const cv=this.el.querySelector('canvas'),ctx=cv.getContext('2d'),a=this.history.ordered(),w=cv.width,h=cv.height,scale=Math.max(34,this.history.summary().p99*1.2);
    ctx.clearRect(0,0,w,h);ctx.strokeStyle='#35404e';ctx.lineWidth=1;
    for(const ms of [8.33,16.67,33.33]){const y=h-ms/scale*h;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
    ctx.beginPath();for(let i=0;i<a.length;i++){const x=i/Math.max(1,a.length-1)*w,y=h-Math.min(scale,a[i])/scale*h;if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);}
    ctx.strokeStyle='#ff4fa3';ctx.lineWidth=2;ctx.stroke();
  }
  adminStatus(text,error=false){const e=this.el.querySelector('[data-admin-status]');e.textContent=text;e.classList.toggle('error',error);}
  async action(a) {
    const g=this.g,t=this.t,c=g.net?.client;
    if(a.startsWith('tab:'))return this.setSection(a.slice(4));
    if(a==='hud'){this.hudOn=!this.hudOn;this.hud.hidden=!this.hudOn;this.syncLoop();}
    else if(a==='disable'){this.destroy();this.menu.removeTab('debug');return;}
    else if(a==='export'){
      const blob=new Blob([JSON.stringify(diagnostics(g,this.history),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),el=document.createElement('a');
      el.href=url;el.download='leonida-diagnostics.json';el.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }else if(a.startsWith('fx:')){const k=a.slice(3);g.render.setEffect(k,!g.render.effects[k]);}
    else if(a==='restoreFx'){for(const [k,on] of Object.entries(this.originalEffects))g.render.setEffect(k,on);}
    else if(a.startsWith('net:')){if(!c)return;c.link??=new LinkEmulator();c.link.configure(a.slice(4));this.hudOn=c.link.active;this.hud.hidden=!this.hudOn;this.syncLoop();}
    else if(a.startsWith('view:'))this.viewCrossing(a.slice(5));
    else if(a==='driver'){g.ui.close();g.player.setFree(false);if(this.cameraFov){g.camera.fov=this.cameraFov;g.camera.updateProjectionMatrix();this.cameraFov=0;}}
    else if(a==='day'&&g.can('time')){g.sky.setTime(10,{smooth:false});g.sky.paused=true;g.weather.setAuto(false);g.weather.set('clear',0);}
    else if(a==='colliders'){this.colliders=!this.colliders;if(!this.colliders)this.clearColliders();this.syncLoop();}
    else if(a.startsWith('players:')){await this.loadPlayers(a.slice(8));}
    else if(['login','credit','unlock','thaw','logout','travel_to','bring'].includes(a)){
      if(this.busy)return;this.busy=true;
      const p=this.el.querySelector('[type=password]'),values=a==='login'?{password:p.value}:a==='credit'?{amount:Number(this.el.querySelector('#ld-admin-amount').value)}:a==='travel_to'||a==='bring'?{target:Number(this.el.querySelector('#ld-admin-player').value)}:{};
      if(a==='login')p.value='';
      this.adminStatus(t('Выполняется…','Working…'));this.refresh();
      try{const r=await(c?.admin(a,values)||Promise.resolve({ok:false,reason:'offline'}));
        const errors={player:t('Игрок уже вышел. Обновите список.','That player has left. Refresh the list.'),update:t('Игроку нужно обновить страницу игры.','That player needs to reload the game.'),busy:t('Уже выполняется перемещение. Подождите.','A move is already in progress. Please wait.'),blocked:t('Рядом нет свободного места для этого транспорта.','There is no clear space nearby for this vehicle.'),space:t('Рядом нет свободного места для этого транспорта.','There is no clear space nearby for this vehicle.'),dead:t('Дождитесь возрождения игрока.','Wait for the player to respawn.'),password:t('Пароль не подошёл. Попробуйте ещё раз.','Incorrect password. Try again.'),rate:t('Слишком много запросов. Попробуйте позже.','Too many requests. Try again later.'),auth:t('Время доступа истекло. Войдите снова.','Access expired. Sign in again.'),amount:t('Введите сумму от $1 до $100 000 000. Максимальный баланс — $1 млрд.','Enter $1–$100,000,000. Maximum balance: $1 billion.'),timeout:t('Ответ задерживается. Проверьте баланс перед повтором.','Response delayed. Check your balance before retrying.')};
        this.adminStatus(r.ok?t('Готово.','Done.'):errors[r.reason]||t('Сейчас выполнить не удалось. Проверьте соединение.','Could not complete this. Check your connection.'),!r.ok);
        if(r.ok&&a==='login')await this.loadPlayers('refresh');
      }finally{values.password='';this.busy=false;}
    }
    this.refresh();
  }
  async loadPlayers(action) {
    if(this.playersLoading||performance.now()<(this.playersAt||0)+1000)return;
    this.playersLoading=true;this.playerCursors??=[0];this.playerPage??=0;
    let page=action==='refresh'?0:action==='prev'?Math.max(0,this.playerPage-1):this.playerPage+1;
    const cursor=action==='next'?this.playersNext:(this.playerCursors[page]||0);
    const status=this.el.querySelector('[data-players-status]');status.textContent=this.t('Загрузка…','Loading…');this.refresh();
    try {
      const result=await this.g.net.listOnline(cursor);
      if(this.destroyed)return;
      if(result.timeout){status.textContent=this.t('Ответ задерживается. Попробуйте обновить список.','Response delayed. Try refreshing the list.');return;}
      if(action==='refresh')this.playerCursors=[0];
      this.playerCursors[page]=cursor;this.playerPage=page;this.playersNext=result.next;
      const select=this.el.querySelector('#ld-admin-player'),previous=select.value,me=this.g.net.client.welcome?.netId;
      const players=result.players.filter(p=>p.netId!==me&&p.visible!==false);
      select.replaceChildren();
      for(const p of players){const option=document.createElement('option');option.value=p.netId;option.textContent=this.g.net.nameOf(p);select.append(option);}
      if(players.some(p=>String(p.netId)===previous))select.value=previous;
      if(!players.length){const option=document.createElement('option');option.value='';option.textContent=this.t('На этой странице нет других игроков','No other players on this page');select.append(option);}
      status.textContent=`${this.t('Страница','Page')} ${page+1} · ${this.t('В сети','Online')}: ${result.online}`;
    }finally{this.playersLoading=false;this.playersAt=performance.now();if(!this.destroyed)this.refresh();}
  }
  viewCrossing(kind){
    const g=this.g,o=g.roads.overpasses[this.crossing];if(!o)return;
    const low=g.roads.nodeY[o.ni],high=g.roads.nodeY[o.nj],u=o.dir,n=[-u[1],u[0]];
    const [a,b,y]=kind==='under'?[8,40,low+2.1]:kind==='deck'?[42,3,high+2.2]:[110,125,high+70];
    this.cameraFov ||= g.camera.fov;g.ui.close();g.player.setFree(true);
    g.camera.position.set(o.x+u[0]*a+n[0]*b,y,o.z+u[1]*a+n[1]*b);g.camera.fov=kind==='overview'?48:65;g.camera.updateProjectionMatrix();
    g.camera.lookAt(o.x,kind==='under'?low+2:high,o.z);g.player.free.enable(g.camera);g.player.focus.copy(g.camera.position);g.streaming.run(true);
  }
  drawColliders(){
    const g=this.g,T=g.THREE,raw=g.world?.debugRender?.();if(!raw)return;
    const p=g.camera.position,vs=[],cs=[];
    for(let i=0;i<raw.vertices.length&&vs.length<120000;i+=6){if(Math.hypot(raw.vertices[i]-p.x,raw.vertices[i+1]-p.y,raw.vertices[i+2]-p.z)>180)continue;for(let k=0;k<6;k++)vs.push(raw.vertices[i+k]);for(let j=0;j<2;j++){const c=(i/3+j)*4;cs.push(raw.colors[c],raw.colors[c+1],raw.colors[c+2]);}}
    if(!this.lines){this.lines=new T.LineSegments(new T.BufferGeometry(),new T.LineBasicMaterial({vertexColors:true,depthTest:false,transparent:true,opacity:.65}));this.lines.renderOrder=999;this.lines.frustumCulled=false;g.scene.add(this.lines);}
    const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(vs,3));geo.setAttribute('color',new T.Float32BufferAttribute(cs,3));this.lines.geometry.dispose();this.lines.geometry=geo;
  }
  clearColliders(){if(this.lines){this.g.scene.remove(this.lines);this.lines.geometry.dispose();this.lines.material.dispose();this.lines=null;}}
  destroy(){
    if(this.destroyed)return;this.destroyed=true;this.visible=this.hudOn=this.colliders=false;this.syncLoop();this.clearColliders();this.hud.remove();
    this.g.net?.client?.link?.stop();void this.g.net?.client?.admin('logout');
    for(const [k,on] of Object.entries(this.originalEffects))this.g.render.setEffect(k,on);
    if(typeof this.offLang==='function')this.offLang();this.el.onclick=null;
    if(this.cameraFov){this.g.camera.fov=this.cameraFov;this.g.camera.updateProjectionMatrix();this.g.player.setFree(false);}
  }
}
