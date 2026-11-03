import { esc } from './Hud.js';
import { icon } from './icons.js';

// HTML builders for menu rows. Every focusable element carries `data-nav` (keyboard/gamepad navigation).
// Row types (data-type): toggle | choice | slider; actions: data-act="name".

// keyboard/gamepad key cap; A/B/X/Y get the coloured face-button look
export const keycap = (k, pad = false) => `<span class="key${pad && /^[ABXY]$/.test(k) ? ` pad-${k}` : ''}">${esc(k)}</span>`;

export const section = (title, ic) => `<h3 class="sec">${ic ? icon(ic) : ''}<span>${esc(title)}</span></h3>`;

export function toggle(key, label, on, extra = '') {
  return `<div class="row" data-nav data-type="toggle" data-key="${key}" ${extra}><span class="lbl">${esc(label)}</span>`
    + `<span class="sw ${on ? 'on' : ''}"><i></i></span></div>`;
}

// options: [{ v, label }]
export function choice(key, label, options, value) {
  const i = Math.max(0, options.findIndex((o) => sameVal(o.v, value)));
  return `<div class="row" data-nav data-type="choice" data-key="${key}" data-i="${i}" data-n="${options.length}"><span class="lbl">${esc(label)}</span>`
    + `<span class="sel"><b class="l">‹</b><span class="v">${esc(options[i]?.label ?? '')}</span><b class="r">›</b>`
    + `<span class="dots">${options.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</span></span></div>`;
}

export function slider(key, label, { min, max, step, value, text }) {
  return `<div class="row" data-nav data-type="slider" data-key="${key}"><span class="lbl">${esc(label)}</span>`
    + `<span class="sl"><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" tabindex="-1"><output>${esc(text ?? value)}</output></span></div>`;
}

export function button(act, label, { ic, cls = '', attrs = '' } = {}) {
  return `<button class="mbtn ${cls}" data-nav data-act="${act}" ${attrs} tabindex="-1">${ic ? icon(ic) : ''}<span>${esc(label)}</span></button>`;
}

export const sameVal = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-6);

// Update a choice row in place after its value changed.
export function setChoice(el, i, label) {
  el.dataset.i = i;
  el.querySelector('.v').textContent = label;
  el.querySelectorAll('.dots i').forEach((d, k) => d.classList.toggle('on', k === i));
}

// Delegated handlers for a tab root: { toggle(key, on, el), choice(key, dir, el), slider(key, value, el, final), act(name, el, ev) }
export function bindRows(root, h) {
  root.addEventListener('click', (e) => {
    const row = e.target.closest('[data-type]');
    if (row && root.contains(row)) {
      const type = row.dataset.type;
      if (type === 'toggle') {
        const sw = row.querySelector('.sw');
        const on = !sw.classList.contains('on');
        sw.classList.toggle('on', on);
        h.toggle?.(row.dataset.key, on, row);
      } else if (type === 'choice') {
        h.choice?.(row.dataset.key, e.target.closest('.l') ? -1 : 1, row);
      }
      return;
    }
    const a = e.target.closest('[data-act]');
    if (a && root.contains(a)) h.act?.(a.dataset.act, a, e);
  });
  root.addEventListener('nav-adjust', (e) => {
    const row = e.target.closest('[data-type]');
    if (row?.dataset.type === 'choice') h.choice?.(row.dataset.key, e.detail, row);
  });
  root.addEventListener('input', (e) => {
    const row = e.target.closest('[data-type="slider"]');
    if (row) h.slider?.(row.dataset.key, +e.target.value, row, false);
  });
  root.addEventListener('change', (e) => {
    const row = e.target.closest('[data-type="slider"]');
    if (row) h.slider?.(row.dataset.key, +e.target.value, row, true);
  });
}
