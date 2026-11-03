// Route shields and exit markers (our own vector drawings): interstate shield (red crown, blue body), US route
// shield (white badge, black rim), state road (white rounded square), historic route (brown), exit number (green
// disc). Rendered once per (kind, number, dpr, size) into a small canvas sprite and blitted with drawImage, so the
// full map and the radar draw them at the cost of one image copy each.

const FONT = 'Oswald, "Arial Narrow", "Helvetica Neue", Arial, sans-serif';

// size in CSS px at scale 1: [width for 1-2 digits, width for 3+ digits, height]
const DIMS = {
  I: [21, 26, 21],
  US: [20, 25, 20],
  SR: [19, 25, 16],
  H: [22, 28, 16],
  exit: [16, 20, 16],
};

const cache = new Map();

export function shieldSize(kind, text, scale = 1) {
  const d = DIMS[kind] || DIMS.SR;
  return [(text.length >= 3 ? d[1] : d[0]) * scale, d[2] * scale];
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function interstatePath(g, x, y, w, h) {
  g.beginPath();
  g.moveTo(x + w * 0.5, y + h * 0.09);
  g.quadraticCurveTo(x + w * 0.76, y - h * 0.03, x + w * 0.985, y + h * 0.07);
  g.bezierCurveTo(x + w * 1.04, y + h * 0.42, x + w * 0.93, y + h * 0.78, x + w * 0.5, y + h);
  g.bezierCurveTo(x + w * 0.07, y + h * 0.78, x - w * 0.04, y + h * 0.42, x + w * 0.015, y + h * 0.07);
  g.quadraticCurveTo(x + w * 0.24, y - h * 0.03, x + w * 0.5, y + h * 0.09);
  g.closePath();
}

function usPath(g, x, y, w, h) {
  const n = Math.min(w, h) * 0.16; // corner notch
  g.beginPath();
  g.moveTo(x + n, y);
  g.lineTo(x + w - n, y);
  g.quadraticCurveTo(x + w - n * 0.9, y + n * 0.9, x + w, y + n);
  g.bezierCurveTo(x + w * 1.02, y + h * 0.5, x + w * 0.86, y + h * 0.8, x + w * 0.5, y + h);
  g.bezierCurveTo(x + w * 0.14, y + h * 0.8, x - w * 0.02, y + h * 0.5, x, y + n);
  g.quadraticCurveTo(x + n * 0.9, y + n * 0.9, x + n, y);
  g.closePath();
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function fitText(g, text, maxW, size, weight = 500) {
  let s = size;
  g.font = `${weight} ${s}px ${FONT}`;
  while (s > 7 && g.measureText(text).width > maxW) { s -= 0.5; g.font = `${weight} ${s}px ${FONT}`; }
}

// sprite: { canvas, w, h } (w, h in CSS px; canvas in device px)
export function shieldSprite(kind, text, dpr = 1, scale = 1) {
  const key = `${kind}|${text}|${dpr}|${scale}`;
  let sp = cache.get(key);
  if (sp) return sp;
  const [w, h] = shieldSize(kind, text, scale);
  const pad = 3 * scale; // room for the dark halo
  const W = w + pad * 2, H = h + pad * 2;
  const c = makeCanvas(Math.ceil(W * dpr), Math.ceil(H * dpr));
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  g.lineJoin = 'round';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const x = pad, y = pad;
  const halo = 'rgba(6, 8, 12, 0.55)';
  if (kind === 'I') {
    interstatePath(g, x, y, w, h);
    g.lineWidth = 3 * scale; g.strokeStyle = halo; g.stroke();
    g.fillStyle = '#ffffff'; g.fill();
    // inner shield: red crown + blue body
    const i = 1.35 * scale;
    g.save();
    interstatePath(g, x + i, y + i * 1.1, w - 2 * i, h - 2.2 * i);
    g.clip();
    g.fillStyle = '#1d4f9e';
    g.fillRect(x, y, w, h);
    g.fillStyle = '#c8232c';
    g.fillRect(x, y, w, h * 0.27);
    g.fillStyle = '#ffffff';
    g.fillRect(x, y + h * 0.27, w, 0.9 * scale);
    g.restore();
    g.fillStyle = '#ffffff';
    fitText(g, text, w * 0.74, 11.5 * scale);
    g.fillText(text, x + w / 2, y + h * 0.6);
  } else if (kind === 'US') {
    usPath(g, x, y, w, h);
    g.lineWidth = 3.2 * scale; g.strokeStyle = halo; g.stroke();
    g.fillStyle = '#f7f7f5'; g.fill();
    g.lineWidth = 1.3 * scale; g.strokeStyle = '#151515'; g.stroke();
    g.fillStyle = '#151515';
    fitText(g, text, w * 0.72, 11.5 * scale);
    g.fillText(text, x + w / 2, y + h * 0.46);
  } else if (kind === 'exit') {
    const r = h / 2;
    g.beginPath();
    g.arc(x + w / 2, y + r, r, 0, Math.PI * 2);
    g.lineWidth = 3 * scale; g.strokeStyle = halo; g.stroke();
    g.fillStyle = '#0f7a43'; g.fill();
    g.lineWidth = 1.1 * scale; g.strokeStyle = '#e9f6ee';
    g.beginPath(); g.arc(x + w / 2, y + r, r - 1.4 * scale, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#ffffff';
    fitText(g, text, w - 5 * scale, 9.5 * scale);
    g.fillText(text, x + w / 2, y + r + 0.4 * scale);
  } else {
    // state road (white rounded square) / historic route (brown)
    const hist = kind === 'H';
    roundRect(g, x, y, w, h, 3.5 * scale);
    g.lineWidth = 3 * scale; g.strokeStyle = halo; g.stroke();
    g.fillStyle = hist ? '#7a4a1e' : '#f7f7f5'; g.fill();
    g.lineWidth = 1.2 * scale; g.strokeStyle = hist ? '#f1e3c8' : '#151515';
    roundRect(g, x + 1.2 * scale, y + 1.2 * scale, w - 2.4 * scale, h - 2.4 * scale, 2.6 * scale);
    g.stroke();
    g.fillStyle = hist ? '#ffffff' : '#151515';
    fitText(g, text, w - 6 * scale, 10.5 * scale);
    g.fillText(text, x + w / 2, y + h / 2 + 0.4 * scale);
  }
  sp = { canvas: c, w: W, h: H, bw: w, bh: h };
  cache.set(key, sp);
  return sp;
}

export function clearShieldCache() { cache.clear(); }
