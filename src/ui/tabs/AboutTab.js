import { Tab } from './Tab.js';
import { esc } from '../Hud.js';
import { icon, mapSourceLink, MAP_SOURCE } from '../icons.js';
import { VERSION_LABEL } from '../../core/version.js';

const CONTACT = 'help@leonida-drive.io';

// ABOUT: project description, map source credit, credits, disclaimers.
export class AboutTab extends Tab {
  constructor(menu) {
    super(menu, 'about');
    this.icon = 'info';
  }

  build() {
    const credits = ['gtadb', 'osm', 'tech', 'fonts']; // osm: real-world building massing (public/data/irl.json, ODbL)
    this.el.innerHTML = `
      <div class="about" data-nav data-key="about">
        <div class="logo alogo"><div class="l1">LEONIDA</div><div class="l2">drive</div></div>
        <p>${this.t('about.p1')}</p>
        <p>${this.t('about.p2')}</p>
        <div class="srccard">
          <div class="srcico">${icon('map')}</div>
          <div><p>${esc(this.t('credits.mapSource'))}</p>
          <p class="srcrow"><b>${MAP_SOURCE.name}</b> — ${mapSourceLink(MAP_SOURCE.url.replace(/\/$/, ''))}</p></div>
        </div>
        <h3 class="sec">${icon('star')}<span>${esc(this.t('about.credits'))}</span></h3>
        <ul>${credits.map((c) => `<li>${esc(this.t(`about.c.${c}`))}</li>`).join('')}</ul>
        <p class="disc"><b>${esc(this.t('credits.disclaimer'))}</b><br>${esc(this.t('about.disclaimer'))}</p>
        <h3 class="sec">${icon('shield')}<span>${esc(this.t('legal.title'))}</span></h3>
        <div class="legal">${['ip', 'assets', 'real', 'privacy', 'age'].map((k) => `<p>${esc(this.t(`legal.${k}`))}</p>`).join('')}
          <p>${esc(this.t('legal.contact', { email: '\u0000' })).replace('\u0000', `<a href="mailto:${CONTACT}">${CONTACT}</a>`)}</p>
          <p><a href="/licenses.txt" target="_blank" rel="noopener noreferrer">${esc(this.t('legal.licenses'))}</a></p></div>
        <p class="ver"><button type="button" data-debug-unlock style="all:unset;cursor:pointer" data-nav>${esc(this.t('about.version', { v: VERSION_LABEL }))}</button></p>
      </div>`;
    this.el.querySelector('[data-debug-unlock]').onclick = async () => {
      if (this.unlocking) return;
      const now = performance.now();
      if (now - (this.tapAt || 0) > 5000) this.taps = 0;
      this.tapAt = now; this.taps = (this.taps || 0) + 1;
      if (this.taps < 10) return;
      this.taps = 0; this.unlocking = true;
      try { const { installDebug } = await import('../../debug/index.js'); installDebug(this.menu); }
      finally { this.unlocking = false; }
    };
  }

  // arrows scroll the text
  nav(dir) {
    const a = this.el.querySelector('.about');
    if (dir === 'up' || dir === 'down') { a.scrollBy({ top: dir === 'down' ? 80 : -80, behavior: 'smooth' }); return true; }
    return false;
  }

  hints() { return [[['Q', 'E'], 'menu.hint.tabs']]; }
}
