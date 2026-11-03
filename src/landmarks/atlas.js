import * as THREE from 'three';

// One canvas atlas for every landmark sign (terminal names, neon hotel names, taxiway boards, stand numbers…).
// Panels are drawn at alpha 0.55, letters / neon tubes at alpha 1: the sign material makes alpha > 0.6 glow at
// night, so a single texture carries both the daytime look and the emission mask. All names are fictional.
// 2048 x 2560 (WebGL2: non-power-of-two heights mipmap fine); ~28 MB with mipmaps
const W = 2048, H = 2560;
export const FONT = {
  block: '900 {s}px "Arial Black", "Helvetica Neue", Arial, sans-serif',
  bold: '700 {s}px "Helvetica Neue", Arial, sans-serif',
  deco: '700 {s}px "Futura", "Avenir Next Condensed", "Gill Sans", "Trebuchet MS", sans-serif',
  script: 'italic 700 {s}px "Brush Script MT", "Snell Roundhand", "Segoe Script", cursive',
  mono: '700 {s}px "DIN Alternate", "Helvetica Neue", Arial, sans-serif',
};

export class SignAtlas {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.clearRect(0, 0, W, H);
    // skyline packing: height of the filled region per 8-px column; each cell goes where its top is lowest
    this.sky = new Int32Array(W / 8);
    this.top = 0;
    this.cells = new Map();
    // plain white cell for untextured sign faces (vertex colour shows through)
    this.white = this.add('_white', 8, 8, (g, x, y, w, h) => { g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillRect(x, y, w, h); });
  }

  // reserve a w x h cell and draw into it; returns {u0, v0, u1, v1} (v up, as three expects with flipY)
  add(key, w, h, draw) {
    if (this.cells.has(key)) return this.cells.get(key);
    const pad = 4, cw = Math.ceil((w + pad) / 8), sky = this.sky;
    let bestX = -1, bestY = Infinity;
    for (let c = 0; c + cw <= sky.length; c++) {
      let y = 0;
      for (let k = c; k < c + cw; k++) if (sky[k] > y) y = sky[k];
      if (y < bestY) { bestY = y; bestX = c; }
    }
    if (bestX < 0 || bestY + h > H) { console.warn('[landmarks] sign atlas full', key); return this.white; }
    for (let k = bestX; k < bestX + cw; k++) sky[k] = bestY + h + pad;
    this.top = Math.max(this.top, bestY + h + pad);
    const x = bestX * 8, y = bestY;
    this.ctx.save();
    this.ctx.beginPath(); this.ctx.rect(x, y, w, h); this.ctx.clip();
    draw(this.ctx, x, y, w, h);
    this.ctx.restore();
    // inset half a texel so mipmaps do not bleed neighbours
    const c = { u0: (x + 1) / W, u1: (x + w - 1) / W, v0: 1 - (y + h - 1) / H, v1: 1 - (y + 1) / H, w, h };
    this.cells.set(key, c);
    return c;
  }

  get used() { return this.top; }

  // text panel: bg colour (alpha 0.55 = not glowing), fg text (glow when neon), optional border / glow halo
  text(key, text, {
    w = 512, h = 96, font = FONT.block, size = 0, fg = '#ffffff', bg = '#1d1f22', border = null, glow = false,
    vertical = false, align = 'center', italic = false, outline = null, padX = 0.06,
  } = {}) {
    return this.add(key, w, h, (g, x, y, cw, ch) => {
      g.globalAlpha = 1;
      if (bg) { g.fillStyle = withAlpha(bg, 0.55); g.fillRect(x, y, cw, ch); }
      if (border) { g.strokeStyle = withAlpha(border, glow ? 1 : 0.55); g.lineWidth = Math.max(2, ch * 0.05); g.strokeRect(x + g.lineWidth, y + g.lineWidth, cw - g.lineWidth * 2, ch - g.lineWidth * 2); }
      g.save();
      let tw = vertical ? ch : cw, th = vertical ? cw : ch;
      if (vertical) { g.translate(x + cw / 2, y + ch / 2); g.rotate(-Math.PI / 2); g.translate(-tw / 2, -th / 2); } else g.translate(x, y);
      let s = size || th * 0.62;
      const f = () => font.replace('{s}', Math.round(s));
      g.font = f();
      const maxW = tw * (1 - padX * 2);
      const m = g.measureText(text).width;
      if (m > maxW) { s *= maxW / m; g.font = f(); }
      g.textBaseline = 'middle';
      g.textAlign = align;
      const tx = align === 'center' ? tw / 2 : align === 'left' ? tw * padX : tw * (1 - padX);
      if (glow) { g.globalAlpha = 0.28; g.strokeStyle = fg; g.lineJoin = 'round'; g.lineWidth = s * 0.16; g.strokeText(text, tx, th / 2 + s * 0.04); g.globalAlpha = 1; }
      if (outline) { g.strokeStyle = outline; g.lineWidth = s * 0.08; g.strokeText(text, tx, th / 2 + s * 0.04); }
      g.fillStyle = fg;
      g.fillText(text, tx, th / 2 + s * 0.04);
      g.restore();
    });
  }

  // vertical stack of letters (art-deco blade signs): one letter per row
  stack(key, text, { w = 96, h = 512, font = FONT.deco, fg = '#ff5fb0', bg = '#f4efe6', glow = true } = {}) {
    return this.add(key, w, h, (g, x, y, cw, ch) => {
      g.fillStyle = withAlpha(bg, 0.55); g.fillRect(x, y, cw, ch);
      const n = text.length, rh = ch / (n + 0.4);
      const s = Math.min(cw * 0.8, rh * 0.92);
      g.font = font.replace('{s}', Math.round(s));
      g.textAlign = 'center'; g.textBaseline = 'middle';
      if (glow) {
        g.globalAlpha = 0.28; g.strokeStyle = fg; g.lineJoin = 'round'; g.lineWidth = s * 0.16;
        for (let i = 0; i < n; i++) g.strokeText(text[i], x + cw / 2, y + rh * (i + 0.7));
        g.globalAlpha = 1;
      }
      g.fillStyle = fg;
      for (let i = 0; i < n; i++) g.fillText(text[i], x + cw / 2, y + rh * (i + 0.7));
    });
  }

  // airport taxiway sign: segments [{t, kind:'loc'|'dir'|'mand'}]: location = yellow on black,
  // direction = black on yellow, mandatory = white on red
  taxi(key, segs, h = 64) {
    const g0 = this.ctx;
    g0.font = FONT.mono.replace('{s}', Math.round(h * 0.62));
    const ws = segs.map((s) => Math.ceil(g0.measureText(s.t).width + h * 0.5));
    const w = ws.reduce((a, b) => a + b, 0) + 8;
    return this.add(key, w, h, (g, x, y, cw, ch) => {
      g.font = FONT.mono.replace('{s}', Math.round(ch * 0.62));
      g.textAlign = 'center'; g.textBaseline = 'middle';
      let ox = x + 4;
      g.fillStyle = 'rgba(20,20,20,0.55)'; g.fillRect(x, y, cw, ch);
      segs.forEach((s, i) => {
        const bg = s.kind === 'loc' ? '#151515' : s.kind === 'mand' ? '#c8202a' : '#f2c500';
        const fg = s.kind === 'loc' ? '#f2c500' : s.kind === 'mand' ? '#ffffff' : '#111111';
        g.fillStyle = withAlpha(bg, 0.55);
        g.fillRect(ox, y + 3, ws[i] - 2, ch - 6);
        if (s.kind === 'loc') { g.strokeStyle = withAlpha('#f2c500', 0.55); g.lineWidth = 3; g.strokeRect(ox + 4, y + 7, ws[i] - 10, ch - 14); }
        g.fillStyle = fg;
        g.fillText(s.t, ox + ws[i] / 2, y + ch / 2 + 2);
        ox += ws[i];
      });
    });
  }

  texture(renderer) {
    const t = new THREE.CanvasTexture(this.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() || 4);
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }
}

function withAlpha(css, a) {
  if (css.startsWith('#')) {
    const n = parseInt(css.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return css;
}
