import * as THREE from 'three';
import { whenFontsReady } from './util.js';
import '@fontsource/russo-one/latin-400.css';
import '@fontsource/oswald/latin-500.css';
import '@fontsource/oswald/latin-700.css';
import '@fontsource/yellowtail/latin-400.css';

// Billboard memes: 68 original, family-friendly jokes drawn procedurally (Canvas2D doodles + universal meme FORMATS:
// expectation/reality, "nobody:", fake error dialogs, joke charts, local-news headlines, fake ads with small print,
// loading bars, road signs, dating-app cards, flyers). Themes: driving pain, Florida-parody wildlife and weather,
// tourists, rent, gym, office, tech, a few crypto jokes with parody coins ($GATOR, $PELICOIN, $FLAMINGO).
// No meme images, characters, real brands, exchanges or people.
// Atlas: 4 x 17 cells authored at 512 x 180 units (board aspect 14 : 4.9), rasterized per quality (see AD_SCALE).
// Built once at init and redrawn once when web fonts load. Signage deals cells so that identical ads stay far apart.

export const AD_COLS = 4, AD_ROWS = 17, AD_W = 512, AD_H = 180;

const DISP = "'Russo One', 'Arial Black', Impact, sans-serif";
const UI = "Oswald, 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif";
const INK = '#17161d';
const PI2 = Math.PI * 2;

// ------------------------------------------------------------------------------------------------ text helpers
function fit(g, str, font, size, maxW, weight = '') {
  let s = size;
  do { g.font = `${weight} ${s}px ${font}`; s -= 1; } while (g.measureText(str).width > maxW && s > 8);
  return s + 1;
}

// text(g, 'HELLO', x, y, { font, size, maxW, color, weight, align, stroke, lw })
function text(g, str, x, y, { font = UI, size = 30, maxW = 460, color = INK, weight = '700', align = 'left', stroke = null, lw = 5, base = 'alphabetic' } = {}) {
  fit(g, str, font, size, maxW, weight);
  g.textAlign = align;
  g.textBaseline = base;
  if (stroke) { g.lineJoin = 'round'; g.strokeStyle = stroke; g.lineWidth = lw; g.strokeText(str, x, y); }
  g.fillStyle = color;
  g.fillText(str, x, y);
}

function bg(g, color, w = AD_W, h = AD_H) { g.fillStyle = color; g.fillRect(0, 0, w, h); }

function grad(g, stops, x0 = 0, y0 = 0, x1 = 0, y1 = AD_H) {
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  stops.forEach((c, i) => gr.addColorStop(i / (stops.length - 1), c));
  return gr;
}

function rr(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// fill + cartoon outline of the current path
function ink(g, fill, lw = 4, stroke = INK) {
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (lw) { g.lineWidth = lw; g.strokeStyle = stroke; g.lineJoin = 'round'; g.lineCap = 'round'; g.stroke(); }
}

function circle(g, x, y, r, fill, lw = 4) { g.beginPath(); g.arc(x, y, r, 0, PI2); ink(g, fill, lw); }
function poly(g, pts, fill, lw = 4, close = true) {
  g.beginPath(); g.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  if (close) g.closePath();
  ink(g, fill, lw);
}
function stroke(g, pts, lw = 4, color = INK) {
  g.beginPath(); g.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  g.lineWidth = lw; g.strokeStyle = color; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke();
}

function star(g, x, y, r, color) {
  g.fillStyle = color; g.beginPath();
  for (let i = 0; i < 8; i++) { const a = (i / 8) * PI2, q = i % 2 ? r * 0.3 : r; g.lineTo(x + Math.cos(a) * q, y + Math.sin(a) * q); }
  g.closePath(); g.fill();
}

// ------------------------------------------------------------------------------------------------ doodle kit
function withT(g, x, y, s, fn, flip = false) { g.save(); g.translate(x, y); g.scale(flip ? -s : s, s); fn(); g.restore(); }

function wheel(g, x, y, r) { circle(g, x, y, r, '#26262c', 3); circle(g, x, y, r * 0.45, '#c9ccd1', 2); }

function sportsCar(g, x, y, s, color = '#ff3b5c') {
  withT(g, x, y, s, () => {
    poly(g, [-64, 0, -60, -14, -30, -19, -12, -34, 24, -34, 46, -17, 64, -13, 67, 0], color);
    poly(g, [-6, -30, 21, -30, 36, -18, -18, -18], '#9fe3ff', 3);
    stroke(g, [-58, -8, 60, -8], 2, 'rgba(255,255,255,0.6)');
    wheel(g, -38, 2, 12); wheel(g, 42, 2, 12);
  });
}

function junkCar(g, x, y, s) {
  withT(g, x, y, s, () => {
    // cinder blocks instead of wheels
    for (const bx of [-48, 30]) { rr(g, bx, 0, 26, 18, 2); ink(g, '#9a9ea6', 3); g.fillStyle = '#5c6068'; g.fillRect(bx + 5, 5, 6, 8); g.fillRect(bx + 15, 5, 6, 8); }
    poly(g, [-60, 2, -60, -16, -36, -22, -22, -42, 22, -42, 36, -22, 60, -17, 60, 2], '#b9a77a');
    poly(g, [-17, -38, 16, -38, 28, -23, -30, -23], '#cfe4ea', 3);
    stroke(g, [-10, -36, 0, -30, -6, -26, 4, -24], 2); // crack
    circle(g, -42, -10, 7, '#8a5a2b', 0); circle(g, 20, -6, 9, '#8a5a2b', 0); circle(g, 46, -10, 5, '#8a5a2b', 0); // rust
    poly(g, [60, -12, 72, -4, 66, -2], '#7a7f88', 2); // hanging bumper
    // flies
    for (const [fx, fy] of [[-20, -60], [8, -66], [30, -58]]) { circle(g, fx, fy, 2.5, INK, 0); stroke(g, [fx - 6, fy - 4, fx - 2, fy - 2], 1.5); }
  });
}

function tinyCar(g, x, y, s, color) {
  withT(g, x, y, s, () => {
    poly(g, [-26, 0, -26, -10, -14, -12, -8, -22, 10, -22, 16, -12, 26, -10, 26, 0], color, 3);
    poly(g, [-5, -19, 8, -19, 12, -12, -10, -12], '#cfeeff', 2);
    wheel(g, -15, 1, 6); wheel(g, 15, 1, 6);
  });
}

// stick person; o: { color (shirt), skin, shades, face: 'smile'|'sad'|'ouch'|'flat', arms: [ax1, ay1, ax2, ay2] }
function person(g, x, y, s, o = {}) {
  withT(g, x, y, s, () => {
    const skin = o.skin || '#f2c9a0';
    stroke(g, [0, -40, -12, 0], 5); stroke(g, [0, -40, 12, 0], 5); // legs
    poly(g, [-11, -70, 11, -70, 9, -38, -9, -38], o.color || '#3fa6ff', 3); // torso
    const a = o.arms || [-24, -58, 24, -58];
    stroke(g, [-9, -66, a[0], a[1]], 5, skin === '#e8483a' ? '#c23328' : INK);
    stroke(g, [9, -66, a[2], a[3]], 5, skin === '#e8483a' ? '#c23328' : INK);
    circle(g, 0, -86, 15, skin, 3);
    const f = o.face || 'smile';
    if (o.shades) { rr(g, -12, -92, 10, 6, 2); ink(g, INK, 0); rr(g, 2, -92, 10, 6, 2); ink(g, INK, 0); stroke(g, [-2, -90, 2, -90], 2); }
    else { circle(g, -5, -89, 1.8, INK, 0); circle(g, 5, -89, 1.8, INK, 0); }
    if (f === 'smile') { g.beginPath(); g.arc(0, -82, 6, 0.2, Math.PI - 0.2); ink(g, null, 2.5); }
    else if (f === 'sad') { g.beginPath(); g.arc(0, -75, 6, Math.PI + 0.3, -0.3); ink(g, null, 2.5); }
    else if (f === 'ouch') { circle(g, 0, -79, 4, '#5a1a1a', 2); }
    else stroke(g, [-5, -80, 5, -80], 2.5);
  });
}

function phone(g, x, y, s) { withT(g, x, y, s, () => { rr(g, -7, -12, 14, 24, 3); ink(g, '#2a2c33', 2.5); g.fillStyle = '#7fd4ff'; g.fillRect(-4.5, -9, 9, 16); }); }

// cartoon alligator facing right; o: { tie, sad, glasses, mouthOpen }
function gator(g, x, y, s, o = {}) {
  withT(g, x, y, s, () => {
    const G = '#5aa33f', D = '#3d7a2a';
    // tail + body
    g.beginPath(); g.moveTo(-95, -6); g.quadraticCurveTo(-60, -26, -20, -24); g.lineTo(30, -26); g.quadraticCurveTo(40, -27, 46, -22);
    g.lineTo(46, 0); g.lineTo(-30, 2); g.quadraticCurveTo(-70, 2, -95, -6); g.closePath(); ink(g, G);
    for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(-50 + i * 14, -24, 5, Math.PI, 0); ink(g, D, 2.5); }
    // legs
    for (const lx of [-34, 14]) { rr(g, lx, -4, 12, 12, 4); ink(g, G, 3); }
    // head + snout
    g.beginPath(); g.moveTo(40, -26); g.quadraticCurveTo(52, -42, 66, -34); g.lineTo(108, -24); g.quadraticCurveTo(116, -22, 114, -14);
    g.lineTo(46, -10); g.closePath(); ink(g, G);
    const jaw = o.mouthOpen ? 10 : 0;
    g.beginPath(); g.moveTo(46, -10); g.lineTo(112, -12 + jaw); g.quadraticCurveTo(114, -4 + jaw, 106, -2 + jaw); g.lineTo(46, 0); g.closePath(); ink(g, '#8cc96a');
    g.fillStyle = '#fff'; // teeth
    for (let t = 56; t < 106; t += 9) { g.beginPath(); g.moveTo(t, -12 + jaw * ((t - 46) / 66)); g.lineTo(t + 4, -6 + jaw * ((t - 46) / 66)); g.lineTo(t + 8, -12 + jaw * ((t - 46) / 66)); g.fill(); }
    // eye
    circle(g, 60, -38, 8, '#fff', 3); circle(g, 62, -38, 3.5, INK, 0);
    if (o.sad) stroke(g, [52, -50, 66, -46], 3);
    if (o.glasses) { circle(g, 60, -38, 10, null, 3); stroke(g, [70, -38, 80, -34], 3); }
    circle(g, 108, -26, 2, D, 0); // nostril
    if (o.tie) { poly(g, [42, -10, 50, -10, 49, -2, 54, 16, 46, 22, 40, 16, 44, -2], '#e8423b', 3); }
  });
}

function flamingo(g, x, y, s, P = '#ff7ab8', L = '#d4588f') {
  withT(g, x, y, s, () => {
    stroke(g, [0, 0, 0, -48], 3.5, L); // standing leg
    stroke(g, [0, -30, -12, -40, 0, -46], 3.5, L); // tucked leg
    g.beginPath(); g.ellipse(0, -58, 26, 16, -0.2, 0, PI2); ink(g, P);
    g.beginPath(); g.moveTo(18, -66); g.bezierCurveTo(34, -90, 6, -104, 12, -124); g.lineWidth = 9; g.strokeStyle = INK; g.stroke();
    g.lineWidth = 6; g.strokeStyle = P; g.stroke();
    circle(g, 16, -128, 9, P, 3);
    poly(g, [22, -133, 34, -128, 36, -118, 31, -112, 29, -121, 22, -124], '#fff', 2.5);
    poly(g, [33, -119, 36, -118, 31, -112, 30, -116], INK, 0);
    circle(g, 17, -131, 2, INK, 0);
  });
}

function pelican(g, x, y, s, box = true) {
  withT(g, x, y, s, () => {
    g.beginPath(); g.ellipse(-10, -30, 34, 22, 0.15, 0, PI2); ink(g, '#eef1f4');
    g.beginPath(); g.ellipse(-24, -34, 20, 12, 0.5, 0, PI2); ink(g, '#c9ced6', 3); // wing
    stroke(g, [-2, -10, -4, 6], 4, '#ff9a3d'); stroke(g, [8, -10, 10, 6], 4, '#ff9a3d');
    g.beginPath(); g.moveTo(14, -44); g.quadraticCurveTo(20, -66, 30, -70); g.lineWidth = 12; g.strokeStyle = INK; g.stroke(); g.lineWidth = 8; g.strokeStyle = '#eef1f4'; g.stroke();
    circle(g, 32, -74, 11, '#eef1f4', 3);
    circle(g, 35, -77, 2.2, INK, 0);
    // beak + pouch (with a parcel)
    poly(g, [40, -78, 92, -72, 92, -68, 42, -70], '#ffb347', 3);
    g.beginPath(); g.moveTo(42, -70); g.quadraticCurveTo(66, -36, 92, -68); g.closePath(); ink(g, '#ffd08a', 3);
    if (box) { rr(g, 52, -66, 26, 20, 2); ink(g, '#c8955a', 3); stroke(g, [52, -56, 78, -56], 2); stroke(g, [65, -66, 65, -46], 2); }
  });
}

function sun(g, x, y, r, face = false, shades = false) {
  g.save();
  g.strokeStyle = '#ffb300'; g.lineWidth = 4; g.lineCap = 'round';
  for (let i = 0; i < 12; i++) { const a = (i / 12) * PI2; g.beginPath(); g.moveTo(x + Math.cos(a) * r * 1.2, y + Math.sin(a) * r * 1.2); g.lineTo(x + Math.cos(a) * r * 1.55, y + Math.sin(a) * r * 1.55); g.stroke(); }
  g.restore();
  circle(g, x, y, r, '#ffd23a', 3);
  if (face) {
    if (shades) { rr(g, x - r * 0.62, y - r * 0.32, r * 0.55, r * 0.32, 3); ink(g, INK, 0); rr(g, x + r * 0.07, y - r * 0.32, r * 0.55, r * 0.32, 3); ink(g, INK, 0); }
    else { circle(g, x - r * 0.3, y - r * 0.15, 2, INK, 0); circle(g, x + r * 0.3, y - r * 0.15, 2, INK, 0); }
    g.beginPath(); g.arc(x, y + r * 0.12, r * 0.38, 0.25, Math.PI - 0.25); ink(g, null, 2.5);
  }
}

function cloud(g, x, y, s, fill = '#ffffff') {
  withT(g, x, y, s, () => {
    g.beginPath(); g.arc(-16, 0, 12, Math.PI * 0.5, Math.PI * 1.5); g.arc(-4, -10, 14, Math.PI, Math.PI * 1.9); g.arc(14, -4, 12, Math.PI * 1.3, Math.PI * 0.5); g.closePath();
    ink(g, fill, 3);
  });
}

function bolt(g, x, y, s) { withT(g, x, y, s, () => poly(g, [2, -14, -8, 2, 0, 2, -4, 16, 10, -4, 2, -4, 6, -14], '#ffd23a', 2.5)); }

function spiral(g, x, y, r, color = '#3fa6ff') {
  g.save(); g.strokeStyle = color; g.lineWidth = 5; g.lineCap = 'round';
  for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(x, y, r * (0.35 + k * 0.3), k * 2.1, k * 2.1 + 4.2); g.stroke(); }
  g.restore();
}

function errIcon(g, x, y, r) { circle(g, x, y, r, '#e8423b', 3); stroke(g, [x - r * 0.4, y - r * 0.4, x + r * 0.4, y + r * 0.4], 5, '#fff'); stroke(g, [x + r * 0.4, y - r * 0.4, x - r * 0.4, y + r * 0.4], 5, '#fff'); }
function warnIcon(g, x, y, r) { poly(g, [x, y - r, x + r * 1.1, y + r * 0.8, x - r * 1.1, y + r * 0.8], '#ffd23a', 3); text(g, '!', x, y + r * 0.62, { font: DISP, size: r * 1.25, align: 'center', color: INK }); }

// fictional retro OS dialog; returns the content origin
function dialog(g, x, y, w, h, title, bar = '#ff5fa2') {
  rr(g, x + 6, y + 6, w, h, 8); g.fillStyle = 'rgba(0,0,0,0.25)'; g.fill();
  rr(g, x, y, w, h, 8); ink(g, '#f4f2ee', 4);
  g.save(); rr(g, x, y, w, 30, 8); g.clip(); g.fillStyle = bar; g.fillRect(x, y, w, 30); g.restore();
  stroke(g, [x, y + 30, x + w, y + 30], 3);
  text(g, title, x + 12, y + 22, { size: 18, color: '#fff', maxW: w - 60 });
  rr(g, x + w - 28, y + 6, 20, 18, 4); ink(g, '#ffe3ef', 2);
  stroke(g, [x + w - 23, y + 11, x + w - 13, y + 19], 2.5); stroke(g, [x + w - 13, y + 11, x + w - 23, y + 19], 2.5);
}

function button(g, x, y, w, h, label, primary = false) {
  rr(g, x, y, w, h, 6); ink(g, primary ? '#ffd23a' : '#e4e1da', 3);
  text(g, label, x + w / 2, y + h * 0.72, { size: h * 0.62, align: 'center', maxW: w - 10 });
}

function progress(g, x, y, w, h, frac, color = '#29d16a') {
  rr(g, x, y, w, h, h / 2); ink(g, '#2a2c33', 4);
  g.save(); rr(g, x + 5, y + 5, (w - 10) * frac, h - 10, (h - 10) / 2); g.fillStyle = color; g.fill();
  g.globalAlpha = 0.25; g.fillStyle = '#fff'; g.fillRect(x + 5, y + 6, (w - 10) * frac, (h - 10) * 0.35); g.restore();
}

// headline layout for the fictional "Leonida Daily"
function newspaper(g, l1, l2, sub) {
  bg(g, '#f3efe4');
  g.fillStyle = INK; g.fillRect(14, 12, AD_W - 28, 3); g.fillRect(14, 38, AD_W - 28, 2);
  text(g, 'THE LEONIDA DAILY', 22, 33, { font: DISP, size: 18, maxW: 300 });
  rr(g, AD_W - 128, 15, 112, 21, 3); ink(g, '#e8423b', 0);
  text(g, 'BREAKING', AD_W - 72, 32, { size: 17, align: 'center', color: '#fff', maxW: 100 });
  text(g, l1, 22, 80, { font: DISP, size: 38, maxW: 330 });
  text(g, l2, 22, 120, { font: DISP, size: 38, maxW: 330 });
  text(g, sub, 22, 160, { size: 25, maxW: 300, weight: '500', color: '#5a4a3a' });
}

// two-panel expectation / reality frame
function expReal(g, left, right, labels = ['EXPECTATION', 'REALITY']) {
  bg(g, '#fff');
  g.save(); g.beginPath(); g.rect(0, 0, AD_W / 2, AD_H); g.clip(); left(); g.restore();
  g.save(); g.beginPath(); g.rect(AD_W / 2, 0, AD_W / 2, AD_H); g.clip(); right(); g.restore();
  g.fillStyle = INK; g.fillRect(AD_W / 2 - 3, 0, 6, AD_H);
  for (const [lbl, x, c] of [[labels[0], AD_W / 4, '#1e8a4c'], [labels[1], (AD_W * 3) / 4, '#d6302a']]) {
    fit(g, lbl, DISP, 26, 220, '');
    const w = g.measureText(lbl).width + 22;
    rr(g, x - w / 2, 8, w, 34, 6); ink(g, '#fff', 3);
    text(g, lbl, x, 35, { font: DISP, size: 26, align: 'center', color: c, maxW: 220, weight: '' });
  }
}

function pPanel(g, x, y, size, letter = 'P', color = '#2f6fd8') {
  stroke(g, [x, y, x, y - size * 2.2], 4, '#7a7f88');
  rr(g, x - size / 2, y - size * 2.6, size, size, 5); ink(g, color, 3);
  text(g, letter, x, y - size * 1.85, { font: DISP, size: size * 0.8, align: 'center', color: '#fff', weight: '' });
}

// ----------------------------------------------------------------------------------------- crypto doodles
// generic gold coin (no real coin logos): rim, inner ring, a letter or '$'
function coin(g, x, y, r, label = '$', fill = '#ffc61a') {
  circle(g, x, y, r, fill, Math.max(2.5, r * 0.09));
  g.beginPath(); g.arc(x, y, r * 0.76, 0, PI2); ink(g, null, Math.max(1.5, r * 0.06), '#b07a00');
  if (label) text(g, label, x, y + r * 0.36, { font: DISP, size: r, align: 'center', color: '#a06d00', weight: '', maxW: r * 1.3 });
}

function arrow(g, x0, y0, x1, y1, color = INK, lw = 4, head = 12) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  stroke(g, [x0, y0, x1 - Math.cos(a) * head * 0.6, y1 - Math.sin(a) * head * 0.6], lw, color);
  poly(g, [x1, y1, x1 - Math.cos(a - 0.45) * head, y1 - Math.sin(a - 0.45) * head, x1 - Math.cos(a + 0.45) * head, y1 - Math.sin(a + 0.45) * head], color, 0);
}

// a person standing inside a cardboard box "car" with LAMBO scrawled on it
function boxCar(g, x, y) {
  person(g, x, y - 6, 0.8, { color: '#ffd23a', arms: [-30, -46, 30, -46] });
  poly(g, [x - 66, y - 44, x + 66, y - 44, x + 62, y, x - 62, y], '#c8955a', 4);
  poly(g, [x - 66, y - 44, x - 76, y - 56, x - 40, y - 56, x - 30, y - 44], '#d9a86e', 3); // open flaps
  poly(g, [x + 66, y - 44, x + 78, y - 54, x + 42, y - 56, x + 30, y - 44], '#d9a86e', 3);
  for (const wx of [x - 40, x + 40]) { g.beginPath(); g.arc(wx, y - 6, 11, 0, PI2); ink(g, null, 3); circle(g, wx, y - 6, 2.5, INK, 0); }
  g.fillStyle = 'rgba(240,235,220,0.75)'; g.fillRect(x - 20, y - 42, 12, 40); // tape
  withT(g, x, y - 16, 1, () => { g.rotate(-0.06); text(g, 'LAMBO', 0, 0, { size: 26, align: 'center', color: '#1a1a22', maxW: 100 }); });
}

// ------------------------------------------------------------------------------------------- more doodles
const SCRIPT = "Yellowtail, 'Brush Script MT', cursive";

function palm(g, x, y, s = 1) {
  withT(g, x, y, s, () => {
    g.beginPath(); g.moveTo(-6, 0); g.quadraticCurveTo(-2, -50, 12, -94); g.lineTo(22, -92); g.quadraticCurveTo(8, -50, 6, 0); g.closePath(); ink(g, '#a8743f', 3);
    for (const [ax, ay] of [[-46, -80], [-30, -112], [18, -126], [60, -106], [66, -72]]) {
      g.beginPath(); g.moveTo(17, -94); g.quadraticCurveTo((17 + ax) / 2, ay - 26, ax, ay); g.quadraticCurveTo((17 + ax) / 2, ay - 4, 17, -94); ink(g, '#3fae4a', 3);
    }
    circle(g, 12, -90, 5, '#8a5a2b', 2); circle(g, 22, -88, 5, '#8a5a2b', 2);
  });
}

// cartoon iguana facing right (belly down); frozen → X eyes
function iguana(g, x, y, s, rot = 0, frozen = false) {
  withT(g, x, y, s, () => {
    g.rotate(rot);
    const G = '#5fb84a', D = '#2f7a2a';
    g.beginPath(); g.moveTo(-24, 2); g.quadraticCurveTo(-60, 10, -92, -6); g.lineCap = 'round';
    g.lineWidth = 10; g.strokeStyle = INK; g.stroke(); g.lineWidth = 5; g.strokeStyle = G; g.stroke();
    for (const [lx, d] of [[-16, -1], [14, 1]]) { stroke(g, [lx, 4, lx + d * 9, 18], 6); stroke(g, [lx, 4, lx + d * 9, 18], 3, G); }
    g.beginPath(); g.ellipse(0, 0, 30, 11, 0, 0, PI2); ink(g, G, 3.5);
    for (let i = 0; i < 7; i++) poly(g, [-22 + i * 8, -9, -18 + i * 8, -18, -14 + i * 8, -9], D, 0);
    g.beginPath(); g.ellipse(36, -4, 14, 8.5, -0.15, 0, PI2); ink(g, G, 3.5);
    g.beginPath(); g.arc(31, 5, 6, 0, Math.PI); ink(g, '#9ad46e', 2.5);
    if (frozen) { stroke(g, [37, -10, 43, -4], 2.2); stroke(g, [43, -10, 37, -4], 2.2); }
    else { circle(g, 40, -7, 3, '#fff', 2); circle(g, 41, -7, 1.3, INK, 0); }
  });
}

function mosquito(g, x, y, s) {
  withT(g, x, y, s, () => {
    for (const [bx, kx, ky, fx, fy] of [[-8, -30, -16, -46, 34], [-2, -14, -22, -20, 40], [4, 8, -20, 6, 42], [-6, -42, -8, -66, 20], [6, 28, -16, 36, 36], [2, 18, -26, 24, 44]]) stroke(g, [bx, 4, kx, ky, fx, fy], 2.5);
    g.beginPath(); g.ellipse(-36, 6, 32, 9, 0.22, 0, PI2); ink(g, '#6d5a4a', 3);
    for (let i = 0; i < 4; i++) stroke(g, [-54 + i * 11, -2 + i * 2.6, -52 + i * 11, 12 + i * 2.6], 2, '#e8dcc8');
    circle(g, 0, 0, 12, '#5a4a3c', 3);
    g.beginPath(); g.ellipse(-14, -26, 30, 11, -0.5, 0, PI2); ink(g, 'rgba(210,235,255,0.75)', 2.5);
    g.beginPath(); g.ellipse(4, -30, 26, 10, -1.1, 0, PI2); ink(g, 'rgba(210,235,255,0.75)', 2.5);
    stroke(g, [21, -1, 60, 20], 2.5);
    circle(g, 15, -4, 8, '#5a4a3c', 3); circle(g, 18, -6, 3.5, '#ff4d5e', 0);
    stroke(g, [16, -11, 24, -26], 2); stroke(g, [19, -10, 34, -20], 2);
  });
}

function fish(g, x, y, s, color = '#ff9a3d', flip = false) {
  withT(g, x, y, s, () => {
    poly(g, [-20, 0, -38, -13, -38, 13], color, 3);
    g.beginPath(); g.ellipse(0, 0, 26, 14, 0, 0, PI2); ink(g, color, 3);
    stroke(g, [-6, -10, -6, 10], 2, 'rgba(0,0,0,0.25)');
    circle(g, 13, -3, 4.5, '#fff', 2); circle(g, 14, -3, 2, INK, 0);
  }, flip);
}

function house(g, x, y, s, wall = '#f4f2ee', roof = '#d6302a') {
  withT(g, x, y, s, () => {
    poly(g, [-40, 0, -40, -44, 40, -44, 40, 0], wall);
    poly(g, [-50, -42, 0, -80, 50, -42], roof);
    rr(g, -10, -26, 20, 26, 2); ink(g, '#8a5a2b', 3);
    for (const wx of [-32, 18]) { rr(g, wx, -36, 14, 14, 2); ink(g, '#9fe3ff', 2.5); }
  });
}

function duck(g, x, y, s) {
  withT(g, x, y, s, () => {
    g.beginPath(); g.ellipse(0, 0, 16, 10, 0, 0, PI2); ink(g, '#ffd23a', 3);
    circle(g, 9, -12, 8, '#ffd23a', 3); poly(g, [16, -14, 26, -11, 16, -8], '#ff9a3d', 2); circle(g, 11, -14, 1.6, INK, 0);
  });
}

function heart(g, x, y, r, color = '#ff3b5c', lw = 3) {
  g.beginPath(); g.moveTo(x, y + r * 0.9);
  g.bezierCurveTo(x - r * 1.6, y - r * 0.2, x - r * 0.7, y - r * 1.3, x, y - r * 0.45);
  g.bezierCurveTo(x + r * 0.7, y - r * 1.3, x + r * 1.6, y - r * 0.2, x, y + r * 0.9);
  ink(g, color, lw);
}

// speech bubble with a tail at the bottom-left
function bubble(g, x, y, w, h, str, size = 18, color = INK) {
  rr(g, x, y, w, h, 8); ink(g, '#fff', 3);
  poly(g, [x + 12, y + h - 3, x + 8, y + h + 12, x + 28, y + h - 3], '#fff', 0);
  stroke(g, [x + 12, y + h, x + 8, y + h + 12, x + 28, y + h], 3);
  text(g, str, x + w / 2, y + h / 2 + size * 0.36, { size, align: 'center', color, maxW: w - 10 });
}

function dumbbell(g, x, y, s = 1) {
  withT(g, x, y, s, () => { stroke(g, [-14, 0, 14, 0], 4); rr(g, -20, -8, 7, 16, 2); ink(g, '#3a3c44', 2); rr(g, 13, -8, 7, 16, 2); ink(g, '#3a3c44', 2); });
}

function tumbleweed(g, x, y, r) {
  g.save(); g.strokeStyle = '#a07a45'; g.lineWidth = 2.5;
  for (let k = 0; k < 7; k++) { g.beginPath(); g.ellipse(x, y, r, r * (0.45 + (k % 3) * 0.2), k * 0.9, 0, PI2); g.stroke(); }
  g.restore();
}

function hwySign(g, color = '#1d6b3f') { bg(g, color); rr(g, 10, 10, AD_W - 20, AD_H - 20, 10); ink(g, null, 4, '#ffffff'); }

// lower half of a pool of water with a wavy top edge from x0 to x1 at height y
function water(g, x0, x1, y, color = 'rgba(42,159,208,0.88)') {
  g.beginPath(); g.moveTo(x0, AD_H);
  for (let x = x0; x <= x1; x += 8) g.lineTo(x, y + Math.sin(x * 0.12) * 3);
  g.lineTo(x1, AD_H); g.closePath(); g.fillStyle = color; g.fill();
  g.beginPath(); for (let x = x0; x <= x1; x += 8) g.lineTo(x, y + Math.sin(x * 0.12) * 3);
  g.lineWidth = 3; g.strokeStyle = '#ffffff'; g.stroke();
}

// --------------------------------------------------------------------------------------------------- the memes
const ADS = [
  { id: 'exp-car', draw(g) {
    expReal(g, () => {
      g.fillStyle = grad(g, ['#bfe8ff', '#ffe7f3']); g.fillRect(0, 0, 256, 180);
      g.fillStyle = '#9aa0a8'; g.fillRect(0, 150, 256, 30);
      sun(g, 214, 70, 16);
      sportsCar(g, 122, 148, 1.45);
      star(g, 40, 70, 10, '#fff'); star(g, 200, 120, 8, '#fff'); star(g, 66, 112, 6, '#fff');
      stroke(g, [10, 120, 34, 120], 3, '#ffffff'); stroke(g, [6, 132, 26, 132], 3, '#ffffff');
    }, () => {
      g.fillStyle = '#efe6d3'; g.fillRect(256, 0, 256, 180);
      g.fillStyle = '#c7b48c'; g.fillRect(256, 150, 256, 30);
      junkCar(g, 384, 132, 1.3);
    });
  } },
  { id: 'exp-beach', draw(g) {
    expReal(g, () => {
      g.fillStyle = grad(g, ['#7fd3ff', '#cdefff']); g.fillRect(0, 0, 256, 180);
      g.fillStyle = '#2aa9c8'; g.fillRect(0, 118, 256, 20); g.fillStyle = '#f2dca4'; g.fillRect(0, 138, 256, 42);
      sun(g, 210, 76, 15, true, true);
      person(g, 110, 170, 1.0, { shades: true, color: '#ff5fa2', arms: [-26, -62, 30, -96] });
      phone(g, 142, 77, 1.1);
      star(g, 160, 60, 7, '#fff');
    }, () => {
      g.fillStyle = grad(g, ['#ffb070', '#ffe2b0']); g.fillRect(256, 0, 256, 180);
      g.fillStyle = '#f2dca4'; g.fillRect(256, 138, 256, 42);
      sun(g, 470, 72, 15, true);
      person(g, 384, 170, 1.0, { skin: '#e8483a', color: '#e8483a', face: 'ouch', arms: [-30, -48, 30, -48] });
      // pincer hands
      poly(g, [384 - 34, 122, 384 - 44, 114, 384 - 40, 126, 384 - 46, 130, 384 - 34, 128], '#e8483a', 2.5);
      poly(g, [384 + 34, 122, 384 + 44, 114, 384 + 40, 126, 384 + 46, 130, 384 + 34, 128], '#e8483a', 2.5);
      for (const hx of [354, 384, 414]) stroke(g, [hx, 64, hx + 4, 56, hx - 2, 48, hx + 2, 40], 2.5, '#d6302a');
      text(g, 'OUCH!', 318, 76, { font: DISP, size: 24, color: '#d6302a', align: 'center', weight: '', maxW: 80 });
    });
  } },
  { id: 'nobody', draw(g) {
    bg(g, '#ffffff');
    text(g, 'Nobody:', 24, 46, { size: 34, maxW: 260 });
    text(g, 'Absolutely nobody:', 24, 88, { size: 34, maxW: 260 });
    text(g, 'Leonida drivers:', 24, 132, { size: 36, maxW: 270, color: '#d6302a' });
    text(g, '*merges across 4 lanes*', 24, 166, { size: 22, maxW: 260, weight: '500', color: '#555' });
    // 4 lanes from above + the merge
    g.fillStyle = '#4a4b52'; g.fillRect(300, 10, 196, 160);
    for (let i = 1; i < 4; i++) for (let y = 14; y < 170; y += 22) { g.fillStyle = '#fff'; g.fillRect(300 + i * 49 - 2, y, 4, 12); }
    g.save(); g.setLineDash([2, 8]); stroke(g, [324, 160, 340, 120, 420, 80, 472, 30], 4, '#ffd23a'); g.restore();
    poly(g, [472, 16, 482, 36, 464, 32], '#ffd23a', 0);
    withT(g, 380, 96, 1, () => { g.rotate(-0.9); rr(g, -10, -16, 20, 32, 5); ink(g, '#ff3b5c', 3); });
    for (const [cx, cy] of [[324, 40], [422, 140], [470, 120]]) { rr(g, cx - 9, cy - 15, 18, 30, 4); ink(g, '#cfd3da', 3); }
    text(g, '!!!', 436, 110, { font: DISP, size: 22, color: '#ffd23a', weight: '', maxW: 60 });
  } },
  { id: 'monday', draw(g) {
    bg(g, '#2bb3a6');
    dialog(g, 26, 14, 460, 152, 'Monday.exe');
    errIcon(g, 70, 82, 24);
    text(g, 'Monday.exe has', 110, 78, { size: 34, maxW: 360 });
    text(g, 'stopped responding.', 110, 112, { size: 34, maxW: 360 });
    button(g, 264, 126, 96, 30, 'Close');
    button(g, 372, 126, 96, 30, 'Cry', true);
  } },
  { id: 'err404', draw(g) {
    bg(g, '#6a5acd');
    dialog(g, 26, 14, 460, 152, 'Parking Assistant', '#3f7fd8');
    text(g, 'ERROR 404', 46, 84, { font: DISP, size: 44, color: '#d6302a', weight: '', maxW: 260 });
    text(g, 'Parking spot not found.', 46, 118, { size: 28, maxW: 300 });
    pPanel(g, 410, 104, 34);
    stroke(g, [384, 46, 438, 100], 5, '#d6302a'); stroke(g, [438, 46, 384, 100], 5, '#d6302a');
    button(g, 46, 128, 110, 28, 'Retry');
    button(g, 168, 128, 220, 28, 'Circle the block forever', true);
  } },
  { id: 'gps', draw(g) {
    bg(g, '#ffb347');
    dialog(g, 26, 14, 460, 152, 'Navigation', '#e8423b');
    warnIcon(g, 72, 86, 26);
    text(g, 'Your GPS has given up.', 114, 82, { size: 32, maxW: 350 });
    text(g, 'Recalculating... your life choices', 114, 114, { size: 23, maxW: 350, weight: '500' });
    button(g, 372, 128, 96, 28, 'OK  :(', true);
  } },
  { id: 'brain', draw(g) {
    bg(g, '#1d1b2e');
    // head with a loading spinner inside
    circle(g, 78, 92, 52, '#f2c9a0', 4);
    g.save(); g.lineCap = 'round';
    for (let i = 0; i < 8; i++) { const a = (i / 8) * PI2; g.strokeStyle = `rgba(41,208,224,${0.25 + (i / 8) * 0.75})`; g.lineWidth = 6; g.beginPath(); g.moveTo(78 + Math.cos(a) * 14, 92 + Math.sin(a) * 14); g.lineTo(78 + Math.cos(a) * 26, 92 + Math.sin(a) * 26); g.stroke(); }
    g.restore();
    text(g, 'BRAIN.EXE', 150, 60, { font: DISP, size: 36, color: '#29f0e0', weight: '', maxW: 320 });
    progress(g, 150, 76, 330, 36, 0.99, '#29d16a');
    text(g, 'Loading... 99%', 150, 150, { size: 32, color: '#fff', maxW: 210 });
    text(g, 'for 3 years', 476, 150, { size: 22, color: '#a9a3c9', weight: '500', align: 'right', maxW: 120 });
  } },
  { id: 'gas-salary', draw(g) {
    bg(g, '#ffffff');
    for (const [x0, title, up, col] of [[16, 'GAS PRICE', true, '#e8423b'], [264, 'MY SALARY', false, '#2f6fd8']]) {
      rr(g, x0, 10, 232, 160, 8); ink(g, '#f6f7fa', 3);
      g.strokeStyle = '#dde2ea'; g.lineWidth = 1.5;
      for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(x0 + 10, 50 + i * 28); g.lineTo(x0 + 222, 50 + i * 28); g.stroke(); }
      text(g, title, x0 + 116, 42, { font: DISP, size: 28, align: 'center', color: col, weight: '', maxW: 210 });
      const pts = up ? [x0 + 18, 156, x0 + 60, 140, x0 + 92, 146, x0 + 130, 110, x0 + 160, 116, x0 + 196, 66] : [x0 + 18, 70, x0 + 60, 84, x0 + 92, 78, x0 + 130, 116, x0 + 160, 110, x0 + 196, 156];
      stroke(g, pts, 7, col);
      const ex = pts[10], ey = pts[11];
      if (up) poly(g, [ex - 10, ey + 14, ex + 18, ey - 12, ex + 4, ey + 20], col, 0); else poly(g, [ex - 10, ey - 14, ex + 18, ey + 12, ex + 4, ey - 20], col, 0);
    }
  } },
  { id: 'pie', draw(g) {
    bg(g, '#fff6e0');
    text(g, 'HOW I SPEND', 22, 58, { font: DISP, size: 34, maxW: 270, weight: '' });
    text(g, 'MY DAY', 22, 98, { font: DISP, size: 34, maxW: 270, weight: '' });
    rr(g, 24, 118, 20, 20, 3); ink(g, '#e8423b', 3); text(g, '90% TRAFFIC', 52, 136, { size: 22, maxW: 210 });
    rr(g, 24, 146, 20, 20, 3); ink(g, '#ffd23a', 3); text(g, '10% HONKING', 52, 164, { size: 22, maxW: 210 });
    const cx = 392, cy = 92, r = 74, a0 = -Math.PI / 2, a1 = a0 + PI2 * 0.9;
    g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, r, a0, a1); g.closePath(); ink(g, '#e8423b', 4);
    g.beginPath(); g.moveTo(cx + 6, cy - 6); g.arc(cx + 6, cy - 6, r, a1, a0 + PI2); g.closePath(); ink(g, '#ffd23a', 4);
    tinyCar(g, 372, 116, 1.25, '#ffffff');
  } },
  { id: 'gator-parking', draw(g) {
    newspaper(g, 'MAN WRESTLES ALLIGATOR', 'FOR PARKING SPOT', 'Loses. Gets a ticket anyway.');
    g.fillStyle = '#9aa0a8'; g.fillRect(360, 140, 140, 26);
    g.fillStyle = '#fff'; g.fillRect(372, 140, 4, 26); g.fillRect(488, 140, 4, 26);
    pPanel(g, 496, 140, 22);
    gator(g, 416, 156, 0.6, { glasses: true });
    rr(g, 418, 54, 46, 26, 3); ink(g, '#ffe066', 2.5); text(g, 'TICKET', 441, 72, { size: 13, align: 'center', maxW: 40 });
  } },
  { id: 'gator-hoa', draw(g) {
    newspaper(g, 'ALLIGATOR ELECTED', 'HOA PRESIDENT', 'First rule: everyone moves out.');
    gator(g, 398, 154, 0.66, { tie: true });
    rr(g, 440, 56, 52, 64, 4); ink(g, '#fff', 3); // clipboard
    for (let i = 0; i < 4; i++) stroke(g, [448, 72 + i * 12, 484, 72 + i * 12], 2.5, '#9aa0a8');
    text(g, 'RULES', 466, 66, { size: 11, align: 'center', maxW: 44 });
  } },
  { id: 'lawyer', draw(g) {
    bg(g, '#ffd23a');
    text(g, 'LAWYER?', 22, 72, { font: DISP, size: 62, maxW: 300, weight: '' });
    text(g, 'I barely know her.', 24, 112, { size: 32, maxW: 300 });
    rr(g, 20, 124, 330, 44, 6); ink(g, '#d6302a', 3);
    text(g, 'CALL 1-800-SUE-THEM', 185, 157, { font: DISP, size: 26, align: 'center', color: '#fff', weight: '', maxW: 310 });
    // briefcase doodle
    rr(g, 380, 70, 108, 76, 8); ink(g, '#8a5a2b', 4);
    rr(g, 414, 52, 40, 22, 6); ink(g, null, 4);
    g.fillStyle = '#ffd23a'; g.fillRect(426, 100, 16, 12);
    text(g, '$$$', 434, 138, { font: DISP, size: 18, align: 'center', color: '#ffd23a', weight: '', maxW: 60 });
  } },
  { id: 'insurance', draw(g) {
    bg(g, '#1f4f8a');
    text(g, 'HURRICANE', 22, 58, { font: DISP, size: 44, color: '#fff', maxW: 300, weight: '' });
    text(g, 'INSURANCE', 22, 100, { font: DISP, size: 44, color: '#fff', maxW: 300, weight: '' });
    text(g, 'Covers everything!*', 24, 136, { size: 28, color: '#bfe3ff', maxW: 300 });
    text(g, '*except hurricanes', 24, 166, { size: 24, color: '#ffd23a', maxW: 300 });
    // house + spiral
    spiral(g, 438, 60, 44, '#9fd3ff');
    poly(g, [380, 168, 380, 118, 412, 92, 444, 118, 444, 168], '#f4f2ee');
    poly(g, [372, 120, 412, 84, 452, 120], '#d6302a');
    rr(g, 402, 138, 20, 30, 2); ink(g, '#8a5a2b', 3);
    withT(g, 466, 120, 1, () => { g.rotate(0.7); poly(g, [-4, -30, 4, -30, 4, 10, -4, 10], '#c9ccd1', 3); }); // flying roof plank
  } },
  { id: 'spf', draw(g) {
    bg(g, '#ff9f1c');
    text(g, 'SUNSCREEN', 22, 52, { size: 32, maxW: 280 });
    text(g, 'SPF 9000', 22, 104, { font: DISP, size: 58, maxW: 290, weight: '' });
    text(g, 'You will glow in the dark.', 24, 150, { size: 28, maxW: 300, color: '#fff' });
    // bottle
    rr(g, 316, 54, 44, 98, 10); ink(g, '#ffffff', 4); rr(g, 326, 36, 24, 20, 4); ink(g, '#2f6fd8', 4);
    text(g, '9000', 338, 112, { font: DISP, size: 15, align: 'center', weight: '', maxW: 40 });
    // glowing person at night
    g.fillStyle = '#1d1b2e'; rr(g, 380, 18, 120, 150, 10); g.fill();
    g.save(); g.shadowColor = '#d8ff4a'; g.shadowBlur = 24; person(g, 440, 158, 0.95, { color: '#e7ff7a', skin: '#f6ffc0', face: 'smile' }); g.restore();
    star(g, 398, 34, 4, '#fff'); star(g, 484, 46, 3, '#fff');
  } },
  { id: 'lottery', draw(g) {
    bg(g, '#4b1f8f');
    for (let i = 0; i < 26; i++) star(g, (i * 97) % AD_W, (i * 53) % AD_H, 3 + (i % 3), 'rgba(255,230,140,0.45)');
    text(g, 'LEONIDA LOTTERY', 22, 64, { font: DISP, size: 36, color: '#ffd23a', maxW: 330, weight: '' });
    text(g, 'You probably', 22, 112, { size: 40, color: '#fff', maxW: 300 });
    text(g, "won't.", 22, 158, { font: DISP, size: 44, color: '#fff', maxW: 300, weight: '' });
    [['#ff4fa3', 7], ['#ffd23a', 13], ['#29f0e0', 0]].forEach(([c, n], i) => {
      const x = 386 + (i % 2) * 54, y = 60 + i * 38;
      circle(g, x, y, 28, c, 4); circle(g, x, y, 14, '#fff', 0);
      text(g, String(n), x, y + 7, { font: DISP, size: 18, align: 'center', weight: '', maxW: 26 });
    });
  } },
  { id: 'summer', draw(g) {
    bg(g, grad(g, ['#59c8ff', '#bdeeff']));
    sun(g, 70, 80, 36, true, true);
    text(g, 'INSTALLING SUMMER...', 132, 58, { font: DISP, size: 32, maxW: 360, weight: '' });
    progress(g, 132, 74, 356, 38, 0.99, '#ff9f1c');
    text(g, '99%', 470, 101, { font: DISP, size: 20, align: 'right', color: '#fff', weight: '', maxW: 60 });
    text(g, 'Time remaining: 8 months', 132, 150, { size: 26, maxW: 356, weight: '500' });
  } },
  { id: 'gator-diet', draw(g) {
    bg(g, '#ffd23a');
    g.save(); g.beginPath(); g.rect(0, 0, AD_W, 14); g.rect(0, AD_H - 14, AD_W, 14); g.clip();
    for (let x = -20; x < AD_W + 20; x += 28) { g.fillStyle = INK; g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 14, 0); g.lineTo(x - 6, AD_H); g.lineTo(x - 20, AD_H); g.fill(); }
    g.restore();
    text(g, 'DO NOT FEED', 22, 62, { font: DISP, size: 40, maxW: 300, weight: '' });
    text(g, 'THE ALLIGATORS', 22, 104, { font: DISP, size: 40, maxW: 300, weight: '' });
    text(g, 'They are on a diet.', 24, 148, { size: 28, maxW: 290 });
    gator(g, 372, 142, 0.66, { sad: true });
    // salad bowl
    g.beginPath(); g.arc(470, 132, 24, 0, Math.PI); ink(g, '#fff', 3);
    for (const [lx, ly] of [[456, 124], [470, 118], [484, 124]]) { g.beginPath(); g.ellipse(lx, ly, 9, 6, 0.4, 0, PI2); ink(g, '#6ac259', 2); }
  } },
  { id: 'honk', draw(g) {
    bg(g, '#ff3fa4');
    text(g, 'HONK IF YOU', 256, 50, { font: DISP, size: 40, align: 'center', color: '#fff', maxW: 470, weight: '' });
    text(g, 'LOVE TRAFFIC', 256, 94, { font: DISP, size: 40, align: 'center', color: '#ffd23a', maxW: 470, weight: '' });
    g.fillStyle = '#4a4b52'; g.fillRect(0, 128, AD_W, 52);
    const cols = ['#ffffff', '#29f0e0', '#ffd23a', '#9fd3ff', '#b6ff7a', '#ffffff', '#ffb347'];
    cols.forEach((c, i) => tinyCar(g, 40 + i * 72, 168, 1.15, c));
    for (const [x, y] of [[110, 124], [328, 120], [470, 126]]) { rr(g, x - 26, y - 20, 52, 22, 6); ink(g, '#fff', 2.5); text(g, 'HONK', x, y - 3, { size: 15, align: 'center', maxW: 46 }); }
  } },
  { id: 'signals', draw(g) {
    bg(g, '#2d6a3e');
    // diamond road sign with a crossed-out blinker
    g.save(); g.translate(96, 90); g.rotate(Math.PI / 4); rr(g, -54, -54, 108, 108, 10); ink(g, '#ffd23a', 5); g.restore();
    poly(g, [70, 90, 92, 72, 92, 82, 112, 82, 112, 98, 92, 98, 92, 108], INK, 0);
    stroke(g, [62, 120, 130, 60], 7, '#d6302a');
    text(g, 'TURN SIGNALS:', 196, 62, { font: DISP, size: 32, color: '#fff', maxW: 300, weight: '' });
    text(g, 'OPTIONAL', 196, 112, { font: DISP, size: 50, color: '#ffd23a', maxW: 300, weight: '' });
    text(g, '(Leonida law)', 198, 152, { size: 26, color: '#d6f0dc', maxW: 290, weight: '500' });
  } },
  { id: 'me-traffic', draw(g) {
    bg(g, '#ffffff');
    text(g, 'ME: leaves 5 min early', 22, 54, { size: 34, maxW: 470 });
    text(g, 'TRAFFIC:', 22, 104, { size: 34, maxW: 200, color: '#d6302a' });
    text(g, 'leaves 10 min earlier', 166, 104, { size: 30, maxW: 330, weight: '500' });
    g.fillStyle = '#4a4b52'; g.fillRect(0, 130, AD_W, 50);
    for (let i = 0; i < 9; i++) tinyCar(g, 30 + i * 56, 170, 1, ['#ff3b5c', '#ffd23a', '#29d0e0', '#ffffff'][i % 4]);
  } },
  { id: 'flamingo', draw(g) {
    bg(g, '#ffd6ea');
    text(g, 'FLAMINGO', 22, 58, { font: DISP, size: 46, color: '#d6307a', maxW: 300, weight: '' });
    text(g, 'PARKING ONLY', 22, 104, { font: DISP, size: 40, maxW: 300, weight: '' });
    text(g, 'Violators will be stared at.', 24, 148, { size: 26, maxW: 300 });
    pPanel(g, 362, 170, 30, 'P', '#d6307a');
    flamingo(g, 446, 172, 1.05);
    // stare lines
    stroke(g, [492, 40, 506, 34], 3); stroke(g, [494, 50, 508, 50], 3);
  } },
  { id: 'pelican', draw(g) {
    bg(g, grad(g, ['#8fdcff', '#e8f8ff']));
    text(g, 'PELICAN EXPRESS', 22, 56, { font: DISP, size: 36, color: '#1f4f8a', maxW: 310, weight: '' });
    text(g, 'Same-day delivery!', 24, 98, { size: 30, maxW: 300 });
    text(g, 'Your package is in my mouth.', 24, 140, { size: 24, maxW: 300, weight: '500', color: '#1f4f8a' });
    cloud(g, 474, 32, 0.95);
    pelican(g, 392, 168, 1.15);
  } },
  { id: 'weather', draw(g) {
    bg(g, '#e9f5ff');
    text(g, 'LEONIDA WEATHER TODAY', 256, 40, { font: DISP, size: 28, align: 'center', color: '#1f4f8a', maxW: 470, weight: '' });
    const slots = [['9 AM', 's'], ['10 AM', 'r'], ['11 AM', 's'], ['NOON', 'h']];
    slots.forEach(([t, k], i) => {
      const x = 70 + i * 124, y = 86;
      rr(g, x - 52, 50, 104, 92, 10); ink(g, '#ffffff', 3);
      if (k === 's') sun(g, x, y, 16, true);
      else if (k === 'r') { cloud(g, x, y - 4, 1.3, '#9aa3ad'); bolt(g, x + 4, y + 12, 0.75); }
      else spiral(g, x, y, 26, '#2f6fd8');
      text(g, t, x, 134, { size: 18, align: 'center', maxW: 90 });
    });
    text(g, 'All 4 seasons before lunch.', 256, 166, { size: 21, align: 'center', maxW: 470, weight: '500' });
  } },
  { id: 'captcha', draw(g) {
    bg(g, '#dfe7f1');
    rr(g, 16, 10, 480, 160, 8); ink(g, '#ffffff', 3);
    g.save(); rr(g, 16, 10, 480, 44, 8); g.clip(); g.fillStyle = '#2f6fd8'; g.fillRect(16, 10, 480, 44); g.restore();
    text(g, 'Select all squares with TRAFFIC', 256, 42, { size: 26, align: 'center', color: '#fff', maxW: 450 });
    for (let r = 0; r < 2; r++) for (let c = 0; c < 6; c++) {
      const x = 30 + c * 66, y = 62 + r * 50;
      g.fillStyle = '#5a5c63'; g.fillRect(x, y, 62, 46);
      tinyCar(g, x + 31, y + 36, 0.95, ['#ff3b5c', '#ffd23a', '#29d0e0', '#ffffff', '#b6ff7a', '#ffb347'][(r * 6 + c) % 6]);
      circle(g, x + 52, y + 10, 7, '#2f6fd8', 2); stroke(g, [x + 48, y + 10, x + 51, y + 13, x + 56, y + 7], 2, '#fff');
    }
    text(g, 'yes.', 466, 112, { font: DISP, size: 22, align: 'center', weight: '', maxW: 50 });
    text(g, 'all.', 466, 140, { font: DISP, size: 22, align: 'center', weight: '', color: '#d6302a', maxW: 50 });
  } },

  // ---------------------------------------------------------------- crypto memes (parody coins only, no real brands)
  { id: 'wen-lambo', draw(g) {
    expReal(g, () => {
      g.fillStyle = grad(g, ['#2b1d5c', '#ff8fc7']); g.fillRect(0, 0, 256, 180);
      g.fillStyle = '#5b5e68'; g.fillRect(0, 130, 256, 50);
      for (const [sx, sy, r] of [[22, 60, 7], [236, 54, 6], [60, 100, 5], [206, 104, 5]]) star(g, sx, sy, r, '#fff6c0');
      coin(g, 34, 84, 12); coin(g, 226, 84, 11);
      sportsCar(g, 128, 130, 1.3, '#ffc61a');
    }, () => {
      g.fillStyle = '#efe6d3'; g.fillRect(256, 0, 256, 180);
      g.fillStyle = '#c7b48c'; g.fillRect(256, 130, 256, 50);
      boxCar(g, 384, 134);
      text(g, 'vroom', 492, 74, { size: 18, align: 'right', color: '#8a7a5a', weight: '500', maxW: 60 });
    });
    rr(g, 166, 140, 180, 32, 8); ink(g, '#ffd23a', 4);
    text(g, 'MY CRYPTO LAMBO', 256, 165, { font: DISP, size: 20, align: 'center', weight: '', maxW: 166 });
  } },
  { id: 'crypto-bottom', draw(g) {
    bg(g, '#121726');
    g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 1.5;
    for (let y = 36; y < AD_H; y += 36) { g.beginPath(); g.moveTo(0, y); g.lineTo(AD_W, y); g.stroke(); }
    const L = [14, 24, 58, 44, 78, 38, 110, 72, 126, 60, 150, 64, 182, 100, 198, 88, 226, 94, 262, 130, 280, 118, 300, 124, 336, 160, 350, 152, 380, 196];
    // red area under the line
    g.beginPath(); g.moveTo(L[0], L[1]); for (let i = 2; i < L.length; i += 2) g.lineTo(L[i], L[i + 1]); g.lineTo(380, AD_H); g.lineTo(14, AD_H); g.closePath();
    g.fillStyle = grad(g, ['rgba(255,77,94,0.32)', 'rgba(255,77,94,0.02)'], 0, 20, 0, AD_H); g.fill();
    stroke(g, L, 6, '#ff4d5e');
    text(g, '$GATOR', 18, 132, { font: DISP, size: 24, color: '#fff', weight: '', maxW: 130 });
    text(g, '-97.6%', 18, 156, { font: DISP, size: 20, color: '#ff4d5e', weight: '', maxW: 130 });
    text(g, 'THIS IS THE BOTTOM', 104, 34, { size: 26, color: '#ffffff', maxW: 250 });
    arrow(g, 110, 40, 110, 66, '#ffffff', 4, 11);
    text(g, 'NO, THIS IS THE BOTTOM', 176, 70, { size: 26, color: '#ffd23a', maxW: 300 });
    arrow(g, 182, 76, 182, 96, '#ffd23a', 4, 11);
    text(g, 'OK. THIS ONE. FOR SURE.', 256, 106, { size: 26, color: '#29f0e0', maxW: 238 });
    arrow(g, 262, 112, 262, 126, '#29f0e0', 4, 10);
    text(g, '...right?', 494, 150, { size: 22, color: '#ff8a96', weight: '500', align: 'right', maxW: 110 });
  } },
  { id: 'hodl', draw(g) {
    bg(g, grad(g, ['#0f1424', '#1d2540']));
    stroke(g, [12, 30, 60, 44, 86, 38, 130, 84, 150, 78, 200, 140, 236, 168], 4, 'rgba(255,77,94,0.28)');
    coin(g, 40, 46, 20, 'P');
    text(g, '$PELICOIN', 70, 56, { font: DISP, size: 24, color: '#fff', weight: '', maxW: 166 });
    poly(g, [24, 86, 52, 86, 38, 106], '#ff4d5e', 0);
    text(g, '-98%', 58, 128, { font: DISP, size: 64, color: '#ff4d5e', weight: '', maxW: 176 });
    text(g, 'it\'s just a dip', 24, 157, { size: 20, color: '#8d96b0', weight: '500', maxW: 210 });
    rr(g, 256, 22, 240, 140, 12); ink(g, '#f4f2ee', 4);
    text(g, 'Sell at -98%?', 376, 72, { size: 36, align: 'center', maxW: 214 });
    button(g, 270, 98, 62, 46, 'Yes');
    button(g, 342, 98, 140, 46, 'HODL HARDER', true);
    // cursor already on the big button
    withT(g, 452, 132, 1, () => poly(g, [0, 0, 0, 24, 6, 18, 11, 28, 16, 26, 11, 16, 19, 16], '#ffffff', 2.5));
  } },
  { id: 'gatorcoin', draw(g) {
    bg(g, grad(g, ['#1d7a45', '#0b3a22']));
    for (let i = 0; i < 14; i++) star(g, 300 + ((i * 67) % 200), 14 + ((i * 41) % 150), 2 + (i % 3), 'rgba(255,214,90,0.5)');
    text(g, 'GATORCOIN', 20, 62, { font: DISP, size: 50, color: '#ffd23a', weight: '', maxW: 300, stroke: INK, lw: 7 });
    text(g, 'Backed by absolutely', 24, 102, { size: 30, color: '#ffffff', maxW: 296 });
    text(g, 'NOTHING.*', 24, 142, { font: DISP, size: 34, color: '#ffd23a', weight: '', maxW: 296 });
    text(g, '*not even the gator. not financial advice.', 24, 166, { size: 14, color: '#9fd2b2', weight: '500', maxW: 296 });
    // coin with a gator on it
    circle(g, 418, 92, 72, '#ffc61a', 5);
    g.beginPath(); g.arc(418, 92, 60, 0, PI2); ink(g, '#ffd85a', 3, '#b07a00');
    gator(g, 412, 104, 0.58, { glasses: true });
    text(g, 'IN SWAMP WE TRUST', 418, 134, { size: 13, align: 'center', color: '#8a5d00', maxW: 84 });
  } },
  { id: 'seed-pelican', draw(g) {
    bg(g, grad(g, ['#8fdcff', '#fff4d8']));
    g.fillStyle = '#f2dca4'; g.fillRect(0, 170, AD_W, 10);
    text(g, 'MY SEED PHRASE:', 22, 50, { font: DISP, size: 32, color: '#1f4f8a', weight: '', maxW: 290 });
    text(g, 'Written on a napkin.', 24, 92, { size: 30, maxW: 286 });
    text(g, 'Eaten by a pelican.', 24, 132, { size: 30, color: '#d6302a', maxW: 286 });
    text(g, '(he won\'t give it back)', 24, 164, { size: 20, color: '#1f4f8a', weight: '500', maxW: 286 });
    cloud(g, 470, 36, 0.8);
    pelican(g, 366, 166, 1.1, false);
    // the napkin sticking out of the beak
    withT(g, 470, 92, 1, () => {
      g.rotate(0.35); rr(g, -14, -14, 30, 28, 2); ink(g, '#ffffff', 3);
      for (let i = 0; i < 3; i++) stroke(g, [-9, -6 + i * 8, 10, -6 + i * 8], 2, '#2f6fd8');
    });
    text(g, 'GULP.', 392, 50, { font: DISP, size: 24, color: '#1f4f8a', weight: '', align: 'center', maxW: 80 });
  } },
  { id: 'buy-top', draw(g) {
    newspaper(g, 'LOCAL MAN BUYS', 'THE TOP. AGAIN.', 'Says this time is different.');
    rr(g, 362, 46, 136, 122, 4); ink(g, '#ffffff', 3);
    stroke(g, [370, 160, 392, 140, 406, 148, 436, 100, 452, 138, 468, 126, 490, 164], 4.5, '#d6302a');
    person(g, 436, 98, 0.4, { color: '#2f6fd8', face: 'smile', arms: [-26, -84, 24, -60] });
    g.beginPath(); g.ellipse(436, 74, 22, 30, 0, 0, PI2); ink(g, null, 3, '#d6302a');
    text(g, 'HIM', 370, 102, { font: DISP, size: 20, color: '#d6302a', weight: '', maxW: 44 });
    arrow(g, 396, 88, 412, 80, '#d6302a', 3, 9);
  } },
  { id: 'nft-board', draw(g) { nftBoard(g, 0); } },
  { id: 'rug-pull', draw(g) {
    bg(g, '#fff0d4');
    g.fillStyle = '#e2c79a'; g.fillRect(0, 150, AD_W, 30);
    text(g, 'RUG PULL', 22, 62, { font: DISP, size: 50, color: '#d6302a', weight: '', maxW: 236 });
    text(g, 'a $FLAMINGO story', 24, 100, { size: 28, maxW: 230 });
    // speed lines + the rug flying out to the right
    for (const [y, x0] of [[148, 92], [156, 70], [164, 100]]) stroke(g, [x0, y, x0 + 46, y], 3, '#b8955f');
    poly(g, [150, 146, 340, 140, 346, 160, 156, 166], '#3f7fd8', 4);
    for (let i = 0; i < 6; i++) { const x = 172 + i * 30; poly(g, [x, 151, x + 10, 145, x + 20, 150, x + 10, 158], '#ffd23a', 2); }
    for (let x = 152; x < 346; x += 10) stroke(g, [x, 167 - (x - 152) * 0.03, x - 3, 173 - (x - 152) * 0.03], 2, '#2a5fb0');
    // rope to the getaway gator
    g.beginPath(); g.moveTo(344, 150); g.quadraticCurveTo(370, 172, 398, 160); ink(g, null, 3, '#8a5a2b');
    gator(g, 448, 166, 0.5, { glasses: true });
    for (const y of [140, 150]) stroke(g, [366, y - 4, 384, y - 4], 2.5, '#b8955f');
    // flamingo flipping backwards
    withT(g, 344, 128, 1, () => { g.rotate(-0.5); flamingo(g, 0, 0, 0.8); });
    for (const [x0, y0] of [[318, 134], [338, 142]]) { g.beginPath(); g.arc(x0, y0, 10, 0.3, 2.4); ink(g, null, 2.5, '#b8955f'); }
    coin(g, 384, 50, 11); coin(g, 412, 86, 9); coin(g, 252, 132, 8);
    text(g, '!!', 362, 40, { font: DISP, size: 30, color: '#d6302a', weight: '', maxW: 40 });
  } },

  // ---------------------------------------------------------------- batch 3: everyday Leonida life
  { id: 'iguana-news', draw(g) {
    bg(g, grad(g, ['#7fc8f0', '#d8f1ff']));
    g.fillStyle = '#7cc46a'; g.fillRect(0, 98, AD_W, 14);
    palm(g, 452, 108, 0.9);
    iguana(g, 290, 52, 0.6, Math.PI + 0.25, true);
    iguana(g, 400, 80, 0.5, Math.PI - 0.35, true);
    for (const [lx, ly] of [[278, 14], [296, 12], [392, 46], [408, 44]]) stroke(g, [lx, ly, lx, ly + 14], 2.5, 'rgba(23,22,29,0.45)');
    rr(g, 18, 18, 64, 26, 4); ink(g, '#e8423b', 0); circle(g, 31, 31, 4, '#fff', 0);
    text(g, 'LIVE', 58, 38, { font: DISP, size: 18, align: 'center', color: '#fff', weight: '', maxW: 40 });
    text(g, '45°F', 120, 76, { font: DISP, size: 40, color: '#2f6fd8', weight: '', maxW: 110, stroke: '#fff', lw: 6 });
    g.fillStyle = '#e8423b'; g.fillRect(10, 110, 120, 36); g.fillStyle = '#ffffff'; g.fillRect(130, 110, 372, 36);
    text(g, 'BREAKING', 70, 136, { font: DISP, size: 20, align: 'center', color: '#fff', weight: '', maxW: 110 });
    text(g, "IT'S RAINING IGUANAS", 142, 139, { font: DISP, size: 27, weight: '', maxW: 350 });
    g.fillStyle = '#16234a'; g.fillRect(10, 146, 492, 24);
    text(g, 'Cold snap! Frozen lizards falling from trees. Wear a hat.', 20, 164, { size: 17, color: '#fff', weight: '500', maxW: 474 });
  } },
  { id: 'gator-pool', draw(g) {
    newspaper(g, 'GATOR MOVES INTO', 'FAMILY POOL', 'Pays no rent. Hogs the float.');
    rr(g, 362, 104, 138, 64, 6); ink(g, '#4fc3f7', 3);
    for (let i = 0; i < 3; i++) stroke(g, [372 + i * 42, 158, 392 + i * 42, 158], 2, 'rgba(255,255,255,0.8)');
    g.beginPath(); g.ellipse(430, 128, 54, 14, 0, 0, PI2); ink(g, '#ff7ab8', 3);
    g.beginPath(); g.ellipse(430, 128, 30, 6, 0, 0, PI2); ink(g, '#4fc3f7', 2);
    gator(g, 418, 128, 0.46, { glasses: true });
    stroke(g, [486, 92, 480, 118], 2.5); poly(g, [470, 92, 498, 92, 484, 82], '#ffd23a', 2); // drink umbrella
  } },
  { id: 'state-bird', draw(g) {
    bg(g, grad(g, ['#bfe8ff', '#eef9ff']));
    text(g, 'LEONIDA', 22, 46, { font: DISP, size: 26, color: '#1f4f8a', weight: '', maxW: 250 });
    text(g, 'STATE BIRD:', 22, 94, { font: DISP, size: 44, weight: '', maxW: 270 });
    text(g, "(it's a mosquito)", 24, 132, { size: 30, color: '#d6302a', maxW: 260 });
    text(g, 'Wingspan: yes.', 24, 162, { size: 20, weight: '500', color: '#1f4f8a', maxW: 260 });
    mosquito(g, 392, 78, 1.3);
    person(g, 478, 170, 0.42, { face: 'ouch', arms: [-22, -92, 22, -92] });
  } },
  { id: 'pothole', draw(g) {
    bg(g, grad(g, ['#9fdcff', '#e6f6ff']));
    g.fillStyle = '#4a4b52'; g.fillRect(0, 108, AD_W, 72);
    for (let x = 10; x < 200; x += 70) { g.fillStyle = '#ffd23a'; g.fillRect(x, 160, 36, 5); }
    g.beginPath(); g.ellipse(356, 144, 134, 28, 0, 0, PI2); ink(g, '#2f86c8', 4);
    g.save(); g.beginPath(); g.rect(0, 0, AD_W, 142); g.clip();
    withT(g, 330, 156, 1.7, () => { g.rotate(0.75); tinyCar(g, 0, 0, 1, '#ff3b5c'); });
    g.restore();
    for (const [x, w] of [[296, 34], [338, 26], [410, 30]]) stroke(g, [x, 146, x + w, 146], 2.5, '#bfe8ff');
    duck(g, 440, 140, 1.1);
    text(g, 'NEW LAKE', 22, 52, { font: DISP, size: 44, color: '#1f4f8a', weight: '', maxW: 300 });
    text(g, 'NOW OPEN!', 22, 92, { font: DISP, size: 30, color: '#2f86c8', weight: '', maxW: 300 });
    text(g, "(it's a pothole)", 24, 140, { size: 28, color: '#fff', maxW: 190 });
  } },
  { id: 'toll', draw(g) {
    hwySign(g);
    text(g, 'TOLL PLAZA AHEAD', 256, 46, { font: DISP, size: 30, align: 'center', color: '#fff', weight: '', maxW: 460 });
    [['Toll', '$3'], ['Fee for paying the toll', '$5'], ['Fee for the fee', '$9'], ['Breathing near the booth', '$2']].forEach(([k, v], i) => {
      const y = 78 + i * 26;
      text(g, k, 40, y, { size: 22, color: '#fff', weight: '500', maxW: 330 });
      const w = g.measureText(k).width;
      g.save(); g.setLineDash([2, 7]); stroke(g, [52 + w, y - 6, 424, y - 6], 2.5, 'rgba(255,255,255,0.55)'); g.restore();
      text(g, v, 472, y, { font: DISP, size: 22, align: 'right', color: '#ffd23a', weight: '', maxW: 60 });
    });
  } },
  { id: 'gps-lake', draw(g) {
    bg(g, '#22252c');
    rr(g, 18, 16, 286, 148, 12); ink(g, '#e9f0dc', 4);
    g.save(); rr(g, 18, 16, 286, 148, 12); g.clip();
    g.beginPath(); g.ellipse(118, 112, 96, 42, 0.1, 0, PI2); ink(g, '#5ab4e8', 3);
    for (const [x, y] of [[80, 100], [150, 128]]) stroke(g, [x, y, x + 18, y], 2, '#ffffff');
    stroke(g, [18, 158, 304, 158], 14, '#ffffff'); stroke(g, [244, 170, 244, 50], 14, '#ffffff');
    stroke(g, [244, 166, 244, 104, 142, 104], 8, '#2f6fd8');
    gator(g, 96, 118, 0.34, { mouthOpen: true });
    poly(g, [244, 140, 234, 160, 254, 160], '#ff3b5c', 2.5);
    g.fillStyle = '#1e8a4c'; g.fillRect(18, 16, 286, 40);
    g.restore();
    stroke(g, [62, 50, 62, 34, 46, 34], 5, '#fff'); poly(g, [36, 34, 48, 26, 48, 42], '#fff', 0);
    text(g, 'TURN LEFT NOW', 80, 46, { font: DISP, size: 22, color: '#fff', weight: '', maxW: 214 });
    text(g, 'MY GPS:', 320, 56, { font: DISP, size: 30, color: '#ffd23a', weight: '', maxW: 170 });
    text(g, '"Trust me."', 320, 100, { size: 34, color: '#fff', maxW: 176 });
    text(g, 'Arriving at: the lake', 320, 146, { size: 20, color: '#9aa3b5', weight: '500', maxW: 176 });
  } },
  { id: 'park-here', draw(g) {
    bg(g, '#eef3f7');
    text(g, 'CAN I PARK', 22, 56, { font: DISP, size: 36, weight: '', maxW: 290 });
    text(g, 'HERE?', 22, 112, { font: DISP, size: 56, color: '#d6302a', weight: '', maxW: 290 });
    text(g, 'Yes. No. Only on Tuesdays.', 24, 152, { size: 24, maxW: 290, weight: '500' });
    stroke(g, [420, 174, 420, 14], 7, '#7a7f88');
    [['NO PARKING 8AM-6PM', '#d6302a', '#fff'], ['2 HR PARKING MON-FRI', '#fff', '#1d6b3f'], ['NO PARKING IF RAINING', '#fff', '#d6302a'],
      ['PERMIT ZONE B ONLY', '#1d6b3f', '#fff'], ['FLAMINGOS ONLY', '#ff7ab8', '#fff'], ['TOW-AWAY ZONE', '#ffd23a', INK]].forEach(([t, c, fg], i) => {
      const y = 16 + i * 25;
      rr(g, 338, y, 164, 22, 3); ink(g, c, 2.5);
      text(g, t, 420, y + 16.5, { size: 15, align: 'center', color: fg, maxW: 154 });
    });
  } },
  { id: 'exp-merge', draw(g) {
    const road = (x0) => {
      g.fillStyle = '#6dbb5a'; g.fillRect(x0, 0, 256, 180);
      g.fillStyle = '#4a4b52'; g.beginPath(); g.moveTo(x0, 56); g.lineTo(x0 + 120, 56); g.lineTo(x0 + 170, 82); g.lineTo(x0 + 256, 82);
      g.lineTo(x0 + 256, 132); g.lineTo(x0 + 170, 132); g.lineTo(x0 + 120, 158); g.lineTo(x0, 158); g.closePath(); g.fill();
      g.save(); g.setLineDash([12, 10]); stroke(g, [x0, 107, x0 + 118, 107], 3, '#fff'); g.restore();
    };
    const car = (x, y, a, c) => withT(g, x, y, 1, () => { g.rotate(a); rr(g, -17, -9, 34, 18, 4); ink(g, c, 3); g.fillStyle = 'rgba(160,220,255,0.95)'; g.fillRect(4, -6, 7, 12); });
    const C = ['#ff3b5c', '#ffd23a', '#29d0e0', '#ffffff', '#b6ff7a', '#ffb347', '#c08cff'];
    expReal(g, () => {
      road(0);
      car(22, 82, 0, C[0]); car(82, 82, 0, C[2]); car(52, 132, 0, C[1]); car(112, 132, 0, C[3]);
      car(150, 100, -0.35, C[4]); car(198, 107, 0, C[5]); car(244, 107, 0, C[6]);
    }, () => {
      road(256);
      [[290, 80, 0.3, 0], [300, 132, -0.4, 1], [334, 92, 0.9, 2], [350, 126, -1.3, 3], [376, 100, 0.2, 4], [372, 72, -0.7, 5], [404, 116, 2.6, 6], [322, 112, 1.8, 3]]
        .forEach(([x, y, a, c]) => car(x, y, a, C[c]));
      for (const [x, y] of [[300, 54], [430, 66]]) { rr(g, x - 26, y - 14, 52, 22, 6); ink(g, '#fff', 2.5); text(g, 'HONK', x, y + 3, { size: 15, align: 'center', maxW: 46 }); }
    });
    rr(g, 180, 142, 152, 30, 8); ink(g, '#ffd23a', 4);
    text(g, 'ZIPPER MERGE', 256, 165, { font: DISP, size: 19, align: 'center', weight: '', maxW: 138 });
  } },
  { id: 'left-lane', draw(g) {
    bg(g, '#ffffff');
    text(g, 'LEFT LANE:', 22, 50, { font: DISP, size: 34, weight: '', maxW: 250 });
    text(g, 'PASSING ONLY', 22, 90, { font: DISP, size: 28, color: '#9aa0a8', weight: '', maxW: 240 });
    stroke(g, [16, 80, 28 + g.measureText('PASSING ONLY').width, 80], 5, '#d6302a');
    text(g, 'CAMPING ONLY', 22, 130, { font: DISP, size: 30, color: '#1e8a4c', weight: '', maxW: 240 });
    text(g, '(Leonida rules)', 24, 162, { size: 22, weight: '500', color: '#555', maxW: 240 });
    g.fillStyle = '#bfe8ff'; g.fillRect(270, 0, 242, 96);
    sun(g, 476, 36, 14);
    g.fillStyle = '#4a4b52'; g.fillRect(270, 96, 242, 84);
    for (let x = 276; x < 506; x += 40) { g.fillStyle = '#ffd23a'; g.fillRect(x, 136, 22, 4); }
    poly(g, [392, 132, 426, 84, 460, 132], '#ff8a3d');
    poly(g, [418, 132, 426, 104, 434, 132], '#5a2a00', 2);
    for (const [a, b] of [[470, 488], [474, 492]]) stroke(g, [a, 132, b, 124], 4, '#8a5a2b');
    poly(g, [474, 126, 480, 106, 486, 126], '#ff9a3d', 2); poly(g, [477, 126, 481, 114, 484, 126], '#ffd23a', 0);
    person(g, 360, 134, 0.45, { color: '#ff5fa2', shades: true, arms: [-22, -60, 30, -74] });
    tinyCar(g, 300, 172, 1.05, '#29d0e0'); tinyCar(g, 364, 172, 1.05, '#ffffff');
    rr(g, 282, 102, 52, 22, 6); ink(g, '#fff', 2.5); text(g, 'HONK', 308, 119, { size: 15, align: 'center', maxW: 46 });
  } },
  { id: 'meter', draw(g) {
    bg(g, '#2f6fd8');
    text(g, 'BEACH PARKING', 22, 50, { font: DISP, size: 30, color: '#fff', weight: '', maxW: 310 });
    text(g, '$45/HOUR', 22, 110, { font: DISP, size: 58, color: '#ffd23a', weight: '', maxW: 320 });
    text(g, 'Financing available.', 24, 152, { size: 28, color: '#fff', maxW: 310 });
    stroke(g, [424, 176, 424, 112], 12, '#5c6068');
    rr(g, 372, 22, 104, 94, 30); ink(g, '#c9ccd1', 4);
    rr(g, 388, 40, 72, 32, 6); ink(g, '#1d2540', 3);
    text(g, '0:03', 424, 65, { font: DISP, size: 22, align: 'center', color: '#29f0e0', weight: '', maxW: 64 });
    rr(g, 398, 82, 52, 22, 4); ink(g, '#ffd23a', 2.5);
    text(g, 'LOAN', 424, 98, { size: 15, align: 'center', maxW: 46 });
  } },
  { id: 'car-wash', draw(g) {
    bg(g, '#ffffff');
    text(g, 'ME:', 22, 52, { size: 32, color: '#d6302a', maxW: 60 });
    text(g, '*washes the car*', 80, 52, { size: 30, weight: '500', maxW: 220 });
    text(g, 'THE SKY:', 22, 102, { size: 32, color: '#2f6fd8', maxW: 130 });
    text(g, '*opens*', 152, 102, { size: 30, weight: '500', maxW: 150 });
    text(g, 'Every. Single. Time.', 24, 152, { size: 26, maxW: 280, color: '#555' });
    g.fillStyle = '#e4e8ee'; g.fillRect(304, 150, 208, 30);
    for (let i = 0; i < 9; i++) stroke(g, [354 + i * 13, 96, 348 + i * 13, 120], 3, '#3fa6ff');
    cloud(g, 412, 64, 2.4, '#8d96a5');
    circle(g, 398, 58, 3, INK, 0); circle(g, 424, 58, 3, INK, 0);
    g.beginPath(); g.arc(411, 64, 9, 0.3, Math.PI - 0.6); ink(g, null, 3);
    sportsCar(g, 406, 152, 0.9, '#29d0e0');
    star(g, 336, 132, 7, '#fff'); star(g, 470, 122, 6, '#fff');
  } },
  { id: 'gator-xing', draw(g) {
    bg(g, '#2d6a3e');
    g.save(); g.translate(98, 90); g.rotate(Math.PI / 4); rr(g, -56, -56, 112, 112, 12); ink(g, '#ffd23a', 5); g.restore();
    gator(g, 90, 104, 0.5);
    text(g, 'GATOR CROSSING', 204, 62, { font: DISP, size: 32, color: '#fff', weight: '', maxW: 292 });
    text(g, 'They always have', 206, 104, { size: 30, color: '#d6f0dc', maxW: 288 });
    text(g, 'the right of way.', 206, 142, { size: 30, color: '#ffd23a', maxW: 288 });
  } },
  { id: 'feels-soup', draw(g) {
    bg(g, grad(g, ['#ff8a3d', '#ffcf5a']));
    text(g, '98°F', 22, 78, { font: DISP, size: 62, color: '#fff', weight: '', maxW: 200, stroke: '#c2410c', lw: 7 });
    text(g, 'Humidity: 100%', 24, 114, { size: 26, color: '#5a2a00', maxW: 250 });
    text(g, 'FEELS LIKE: SOUP', 22, 156, { font: DISP, size: 30, color: '#fff', weight: '', maxW: 290, stroke: '#c2410c', lw: 5 });
    sun(g, 250, 48, 20, true);
    person(g, 410, 160, 0.75, { face: 'flat', arms: [-30, -80, 30, -80], color: '#3fa6ff' });
    for (const [dx, dy] of [[-16, 70], [18, 74]]) poly(g, [410 + dx, dy, 413 + dx, dy + 8, 407 + dx, dy + 8], '#3fa6ff', 0);
    g.beginPath(); g.ellipse(410, 118, 78, 14, 0, 0, PI2); ink(g, '#ffb347', 3);
    for (const [x, y] of [[356, 118], [462, 120], [380, 124]]) circle(g, x, y, 5, '#ff7a1a', 2);
    g.beginPath(); g.moveTo(332, 118); g.quadraticCurveTo(332, 172, 410, 172); g.quadraticCurveTo(488, 172, 488, 118); ink(g, '#ffffff', 4);
    stroke(g, [338, 140, 482, 140], 5, '#e8423b');
    g.save(); g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 3; g.lineCap = 'round';
    for (const sx of [364, 456]) { g.beginPath(); g.moveTo(sx, 96); g.bezierCurveTo(sx - 10, 80, sx + 10, 66, sx, 50); g.stroke(); }
    g.restore();
  } },
  { id: 'forecast', draw(g) {
    bg(g, '#e9f5ff');
    text(g, 'LEONIDA FORECAST', 256, 38, { font: DISP, size: 26, align: 'center', color: '#1f4f8a', weight: '', maxW: 460 });
    [['TODAY', '94°F', 15, '#ffffff'], ['TOMORROW', '101°F', 22, '#fff1cc'], ['WEEKEND', '5,000°F', 0, '#ff5a3c']].forEach(([d, t, r, c], i) => {
      const x = 92 + i * 164;
      rr(g, x - 74, 48, 148, 122, 10); ink(g, c, 3);
      if (r) sun(g, x, 104, r, true);
      else { g.save(); rr(g, x - 74, 48, 148, 122, 10); g.clip(); sun(g, x, 108, 48, true, true); g.restore(); rr(g, x - 74, 48, 148, 122, 10); ink(g, null, 3); }
      const hot = i === 2;
      text(g, d, x, 70, { size: 18, align: 'center', maxW: 130, color: hot ? '#fff' : INK, stroke: hot ? '#a01e10' : null, lw: 4 });
      text(g, t, x, 162, { font: DISP, size: 24, align: 'center', weight: '', maxW: 130, color: hot ? '#fff' : INK, stroke: hot ? '#a01e10' : null, lw: 5 });
    });
  } },
  { id: 'bread', draw(g) {
    bg(g, '#1f4f8a');
    spiral(g, 470, 40, 30, '#9fd3ff');
    text(g, 'HURRICANE PLAN:', 22, 48, { font: DISP, size: 30, color: '#fff', weight: '', maxW: 300 });
    text(g, '1. Buy ALL the bread.', 24, 88, { size: 27, color: '#fff', maxW: 290 });
    text(g, '2. Make toast.', 24, 122, { size: 27, color: '#fff', maxW: 290 });
    text(g, '3. Panic.', 24, 156, { size: 27, color: '#ffd23a', maxW: 290 });
    poly(g, [334, 96, 470, 96, 456, 146, 348, 146], 'rgba(200,210,225,0.25)', 4);
    for (const [x, y] of [[354, 90], [388, 86], [422, 88], [452, 92], [370, 68], [404, 64], [438, 70], [392, 46]]) {
      g.beginPath(); g.ellipse(x, y, 21, 12, 0, 0, PI2); ink(g, '#d9a05b', 3);
      for (const d of [-8, 0, 8]) stroke(g, [x + d - 3, y - 6, x + d + 3, y - 2], 2, '#8a5a2b');
    }
    for (let i = 1; i < 5; i++) stroke(g, [334 + i * 27, 98, 348 + i * 22, 144], 2, '#c9d2e0');
    stroke(g, [338, 120, 464, 120], 2, '#c9d2e0');
    stroke(g, [470, 96, 486, 72, 500, 72], 4, '#c9d2e0');
    stroke(g, [348, 146, 456, 146, 452, 156, 354, 156], 4, '#c9d2e0');
    circle(g, 360, 164, 7, '#2a2c33', 2.5); circle(g, 446, 164, 7, '#2a2c33', 2.5);
  } },
  { id: 'exp-fishing', draw(g) {
    expReal(g, () => {
      g.fillStyle = grad(g, ['#9fdcff', '#e6f6ff']); g.fillRect(0, 0, 256, 180);
      g.fillStyle = '#2a9fd0'; g.fillRect(0, 146, 256, 34);
      g.fillStyle = '#a8743f'; g.fillRect(0, 140, 200, 10);
      sun(g, 222, 70, 13);
      person(g, 92, 140, 0.95, { shades: true, arms: [-20, -50, 30, -50] });
      fish(g, 122, 94, 1.55, '#ff9a3d');
      star(g, 46, 78, 7, '#fff'); star(g, 196, 112, 6, '#fff');
    }, () => {
      g.fillStyle = grad(g, ['#9fdcff', '#e6f6ff']); g.fillRect(256, 0, 256, 180);
      g.fillStyle = '#2a9fd0'; g.fillRect(256, 146, 256, 34);
      g.fillStyle = '#a8743f'; g.fillRect(256, 140, 200, 10);
      person(g, 316, 140, 0.95, { face: 'sad', arms: [-20, -50, 30, -50] });
      pelican(g, 404, 140, 0.88, false);
      poly(g, [486, 76, 504, 64, 504, 88], '#ff9a3d', 3);
      text(g, '?!', 276, 70, { font: DISP, size: 24, color: '#d6302a', weight: '', maxW: 40 });
    });
  } },
  { id: 'snowglobe', draw(g) {
    bg(g, grad(g, ['#2bb3a6', '#1d7f8a']));
    text(g, 'GIFT SHOP SPECIAL', 22, 42, { size: 22, color: '#bff5ee', maxW: 280 });
    text(g, 'LEONIDA', 22, 84, { font: DISP, size: 36, color: '#fff', weight: '', maxW: 290 });
    text(g, 'SNOW GLOBE', 22, 120, { font: DISP, size: 36, color: '#fff', weight: '', maxW: 290 });
    text(g, "(it's just sand)", 24, 158, { size: 28, color: '#ffd23a', maxW: 290 });
    rr(g, 348, 132, 124, 34, 6); ink(g, '#8a5a2b', 4);
    g.save(); g.beginPath(); g.arc(410, 82, 56, 0, PI2); g.clip();
    g.fillStyle = '#d9f2ff'; g.fillRect(350, 20, 120, 120);
    g.fillStyle = '#f2dca4'; g.fillRect(350, 112, 120, 30);
    palm(g, 398, 122, 0.55);
    for (let i = 0; i < 46; i++) circle(g, 360 + ((i * 37) % 100), 34 + ((i * 53) % 80), 2 + (i % 2), '#e0c48a', 0);
    g.restore();
    circle(g, 410, 82, 58, null, 4);
    g.beginPath(); g.arc(410, 82, 46, 3.6, 4.4); ink(g, null, 5, 'rgba(255,255,255,0.8)');
    withT(g, 482, 46, 1, () => { g.rotate(0.3); rr(g, -24, -12, 48, 24, 4); ink(g, '#ffd23a', 2.5); text(g, '$29.99', 0, 6, { size: 15, align: 'center', maxW: 42 }); });
  } },
  { id: 'timeshare', draw(g) {
    bg(g, grad(g, ['#ffe08a', '#ff9f7a']));
    palm(g, 452, 174, 0.92);
    text(g, 'FREE VACATION!*', 22, 62, { font: DISP, size: 44, color: '#d6307a', weight: '', maxW: 370, stroke: '#fff', lw: 6 });
    text(g, 'Sun! Sand! Paradise!', 24, 104, { size: 32, maxW: 340 });
    text(g, '*after a short 90-minute presentation.', 24, 140, { size: 18, color: '#6a3a1a', weight: '500', maxW: 340 });
    text(g, 'It lasts 9 hours. The doors are locked.', 24, 162, { size: 18, color: '#6a3a1a', weight: '500', maxW: 340 });
  } },
  { id: 'studio', draw(g) {
    bg(g, '#ffffff');
    g.fillStyle = '#d6302a'; g.fillRect(10, 10, 492, 32);
    text(g, 'FOR RENT: LUXURY STUDIO', 22, 34, { font: DISP, size: 21, color: '#fff', weight: '', maxW: 470 });
    rr(g, 22, 52, 150, 114, 4); ink(g, '#efe6d3', 3);
    rr(g, 52, 62, 92, 104, 2); ink(g, '#c8b48c', 3);
    stroke(g, [52, 84, 144, 84], 3);
    rr(g, 60, 92, 30, 72, 6); ink(g, '#9fd3ff', 3);
    for (let i = 0; i < 3; i++) stroke(g, [64, 110 + i * 18, 86, 110 + i * 18], 2, '#5aa0d8');
    stroke(g, [118, 52, 118, 70], 2); circle(g, 118, 76, 7, '#ffe066', 2.5);
    person(g, 122, 164, 0.5, { face: 'flat', arms: [-14, -40, 14, -40] });
    text(g, '$3,800/mo', 192, 96, { font: DISP, size: 46, color: '#d6302a', weight: '', maxW: 300 });
    text(g, 'Cozy! 40 sq ft. Natural light*', 194, 130, { size: 25, maxW: 300 });
    text(g, '*from the hallway. It is a closet.', 194, 158, { size: 19, color: '#666', weight: '500', maxW: 300 });
  } },
  { id: 'ocean-view', draw(g) {
    bg(g, grad(g, ['#9fdcff', '#e6f6ff']));
    text(g, 'OCEAN VIEW', 22, 54, { font: DISP, size: 46, color: '#1f4f8a', weight: '', maxW: 300 });
    text(g, 'FROM EVERY ROOM!', 22, 94, { font: DISP, size: 28, weight: '', maxW: 300 });
    house(g, 420, 150, 1.3);
    stroke(g, [326, 160, 326, 110], 4, '#8a5a2b');
    rr(g, 294, 100, 66, 24, 3); ink(g, '#fff', 3);
    text(g, 'FOR SALE', 327, 117, { size: 14, align: 'center', color: '#d6302a', maxW: 60 });
    water(g, 0, AD_W, 118);
    fish(g, 380, 148, 0.6, '#ffd23a'); fish(g, 470, 160, 0.5, '#ff7ab8', true);
    text(g, '*the ocean is also in every room', 24, 158, { size: 20, color: '#fff', weight: '500', maxW: 300 });
  } },
  { id: 'pale-flamingo', draw(g) {
    bg(g, '#ffe9f2');
    text(g, 'FLAMINGO', 22, 54, { font: DISP, size: 42, color: '#d6307a', weight: '', maxW: 280 });
    text(g, 'SEES RENT PRICES', 22, 94, { font: DISP, size: 28, weight: '', maxW: 280 });
    text(g, '...turns white.', 24, 138, { size: 32, maxW: 280 });
    stroke(g, [360, 172, 360, 104], 5, '#8a5a2b');
    rr(g, 302, 58, 116, 50, 4); ink(g, '#ffffff', 3);
    text(g, 'RENT', 360, 78, { size: 16, align: 'center', color: '#555', maxW: 100 });
    text(g, '$4,900/mo', 360, 100, { font: DISP, size: 20, align: 'center', color: '#d6302a', weight: '', maxW: 104 });
    withT(g, 466, 172, 1, () => flamingo(g, 0, 0, 1, '#f4f2ee', '#b9bec6'), true);
    for (const [x, y] of [[420, 34], [428, 22], [440, 16]]) stroke(g, [x, y, x - 6, y - 6], 3);
    for (const [x, y] of [[488, 42], [496, 58]]) poly(g, [x, y, x + 4, y + 9, x - 4, y + 9], '#3fa6ff', 0);
  } },
  { id: 'gym', draw(g) {
    expReal(g, () => {
      g.fillStyle = '#f1ece2'; g.fillRect(0, 0, 256, 180); g.fillStyle = '#c9b9a0'; g.fillRect(0, 150, 256, 30);
      const C = ['#ff5fa2', '#3fa6ff', '#ffd23a', '#29d16a', '#ff8a3d', '#c08cff'];
      C.forEach((c, i) => {
        const x = 26 + i * 41, y = 150 + (i % 2) * 8;
        person(g, x, y, 0.6, { color: c, arms: [-22, -84, 22, -84] });
        dumbbell(g, x - 13, y - 51, 0.55); dumbbell(g, x + 13, y - 51, 0.55);
      });
    }, () => {
      g.fillStyle = '#f1ece2'; g.fillRect(256, 0, 256, 180); g.fillStyle = '#c9b9a0'; g.fillRect(256, 150, 256, 30);
      tumbleweed(g, 420, 136, 18);
      for (const x of [380, 396]) stroke(g, [x, 132, x - 22, 132], 2, '#a07a45');
      dumbbell(g, 310, 146, 1);
      g.save(); g.strokeStyle = '#9aa0a8'; g.lineWidth = 1.5;
      for (let k = 0; k < 5; k++) { g.beginPath(); g.moveTo(512, 46); g.lineTo(512 - 44 * Math.cos(k * 0.39), 46 + 44 * Math.sin(k * 0.39)); g.stroke(); }
      for (const r of [16, 30]) { g.beginPath(); g.arc(512, 46, r, Math.PI / 2, Math.PI); g.stroke(); }
      g.restore();
      text(g, 'echo...', 330, 92, { size: 20, color: '#9aa0a8', weight: '500', maxW: 80 });
    }, ['JANUARY', 'FEBRUARY']);
    rr(g, 196, 142, 120, 30, 8); ink(g, '#ffd23a', 4);
    text(g, 'THE GYM', 256, 165, { font: DISP, size: 20, align: 'center', weight: '', maxW: 106 });
  } },
  { id: 'diet', draw(g) {
    bg(g, '#fff6e0');
    text(g, 'MY DIET', 22, 60, { font: DISP, size: 48, weight: '', maxW: 270 });
    text(g, 'STARTS:', 22, 112, { font: DISP, size: 48, color: '#e8423b', weight: '', maxW: 270 });
    text(g, '(every single day)', 24, 152, { size: 26, color: '#555', weight: '500', maxW: 260 });
    withT(g, 330, 150, 1, () => { g.rotate(-0.25); rr(g, -26, -18, 52, 36, 2); ink(g, '#ffffff', 2.5); text(g, 'TOMORROW', 0, 4, { size: 11, align: 'center', maxW: 46 }); });
    rr(g, 336, 22, 150, 128, 6); ink(g, '#ffffff', 4);
    g.save(); rr(g, 336, 22, 150, 128, 6); g.clip(); g.fillStyle = '#e8423b'; g.fillRect(336, 22, 150, 34); g.restore();
    rr(g, 336, 22, 150, 128, 6); ink(g, null, 4);
    for (const x of [372, 450]) { rr(g, x - 4, 14, 8, 18, 3); ink(g, '#9aa0a8', 2); }
    text(g, 'DIET DAY', 411, 46, { size: 18, align: 'center', color: '#fff', maxW: 130 });
    text(g, 'TOMORROW', 411, 112, { font: DISP, size: 26, align: 'center', weight: '', maxW: 136 });
    circle(g, 474, 156, 18, '#ff7ab8', 3); circle(g, 474, 156, 6, '#fff6e0', 2.5);
    for (const [a, c] of [[0.4, '#29d0e0'], [1.6, '#ffd23a'], [2.8, '#29d16a'], [4.2, '#ffffff'], [5.4, '#29d0e0']]) stroke(g, [474 + Math.cos(a) * 11, 156 + Math.sin(a) * 11, 474 + Math.cos(a) * 14, 156 + Math.sin(a) * 13], 2.5, c);
  } },
  { id: 'gator-date', draw(g) {
    bg(g, grad(g, ['#ff7ab8', '#ffb38a'], 0, 0, AD_W, AD_H));
    text(g, 'DATING IN', 22, 52, { font: DISP, size: 32, color: '#fff', weight: '', maxW: 250 });
    text(g, 'LEONIDA', 22, 94, { font: DISP, size: 44, color: '#fff', weight: '', maxW: 250 });
    text(g, '"Loves long walks', 24, 130, { size: 23, maxW: 250, color: '#5a1030' });
    text(g, 'and you (as a snack)."', 24, 158, { size: 23, maxW: 250, color: '#5a1030' });
    rr(g, 288, 14, 206, 154, 12); ink(g, '#ffffff', 4);
    g.save(); rr(g, 298, 24, 186, 88, 8); g.clip(); g.fillStyle = grad(g, ['#9fdcff', '#bdf0c0'], 0, 24, 0, 112); g.fillRect(298, 24, 186, 88);
    gator(g, 378, 104, 0.64, { glasses: true }); g.restore();
    text(g, 'Gary, 34', 302, 136, { size: 24, maxW: 110 });
    text(g, '1 mi away (pond)', 302, 156, { size: 14, weight: '500', color: '#777', maxW: 110 });
    circle(g, 436, 140, 15, '#fff', 3); stroke(g, [430, 134, 442, 146], 3.5, '#9aa0a8'); stroke(g, [442, 134, 430, 146], 3.5, '#9aa0a8');
    circle(g, 472, 140, 15, '#fff', 3); heart(g, 472, 142, 8, '#ff3b5c', 2);
  } },
  { id: 'match', draw(g) {
    bg(g, grad(g, ['#5a1fb0', '#d6307a'], 0, 0, AD_W, AD_H));
    text(g, "It's a Match!", 256, 52, { font: SCRIPT, size: 50, align: 'center', color: '#fff', weight: '', maxW: 420 });
    circle(g, 166, 104, 42, '#bfe8ff', 4);
    g.save(); g.beginPath(); g.arc(166, 104, 40, 0, PI2); g.clip(); pelican(g, 166 - 58 * 0.9, 104 + 72 * 0.9, 0.9, false); g.restore();
    circle(g, 166, 104, 42, null, 4);
    circle(g, 346, 104, 42, '#bfe8ff', 4);
    fish(g, 340, 106, 1.15, '#ff9a3d', true);
    for (const [x, y] of [[372, 82], [380, 96]]) poly(g, [x, y, x + 4, y + 9, x - 4, y + 9], '#3fa6ff', 0);
    heart(g, 256, 106, 22, '#ff3b5c', 3);
    text(g, 'Pelican: "Wanna grab dinner?"', 256, 166, { size: 22, align: 'center', color: '#fff', maxW: 460 });
  } },
  { id: 'reply-all', draw(g) {
    bg(g, '#3f7fd8');
    dialog(g, 26, 14, 460, 152, 'Company Mail', '#2a2c33');
    warnIcon(g, 68, 84, 24);
    text(g, 'You replied "ok"', 108, 78, { size: 32, maxW: 366 });
    text(g, 'to all 4,000 coworkers.', 108, 112, { size: 28, maxW: 366, color: '#d6302a' });
    button(g, 196, 126, 92, 30, 'Undo');
    stroke(g, [196, 141, 288, 141], 3, '#d6302a');
    button(g, 300, 126, 170, 30, 'Move to Alaska', true);
  } },
  { id: 'on-mute', draw(g) {
    bg(g, '#202124');
    text(g, 'THE MEETING:', 22, 50, { font: DISP, size: 28, color: '#fff', weight: '', maxW: 216 });
    text(g, '"You\'re on mute."', 22, 96, { size: 32, color: '#ffd23a', maxW: 216 });
    text(g, 'x 47', 22, 150, { font: DISP, size: 46, color: '#ff4d5e', weight: '', maxW: 200 });
    const C = ['#ff8a3d', '#3fa6ff', '#29d16a', '#c08cff'];
    for (let k = 0; k < 4; k++) {
      const x = 246 + (k % 2) * 128, y = 16 + Math.floor(k / 2) * 76;
      g.save(); rr(g, x, y, 122, 70, 6); g.clip(); g.fillStyle = '#3c4043'; g.fillRect(x, y, 122, 70);
      g.beginPath(); g.ellipse(x + 44, y + 72, 28, 18, 0, 0, PI2); ink(g, C[k], 3);
      circle(g, x + 44, y + 36, 14, '#f2c9a0', 3); circle(g, x + 39, y + 33, 1.6, INK, 0); circle(g, x + 49, y + 33, 1.6, INK, 0);
      g.restore();
      if (k === 0) {
        circle(g, x + 44, y + 42, 4, '#5a1a1a', 0);
        for (const r of [8, 13]) { g.beginPath(); g.arc(x + 58, y + 40, r, -0.6, 0.6); ink(g, null, 2.5, '#fff'); }
        circle(g, x + 104, y + 54, 11, '#e8423b', 0); rr(g, x + 101, y + 46, 6, 11, 3); ink(g, '#fff', 0);
        stroke(g, [x + 96, y + 62, x + 112, y + 46], 2.5, '#fff');
      } else {
        stroke(g, [x + 39, y + 41, x + 49, y + 41], 2);
        bubble(g, x + 66, y + 6, 52, 24, 'MUTE!', 14);
      }
    }
  } },
  { id: 'weekend', draw(g) {
    bg(g, '#1d1b2e');
    rr(g, 22, 26, 92, 124, 6); ink(g, '#ffffff', 4);
    g.save(); rr(g, 22, 26, 92, 124, 6); g.clip(); g.fillStyle = '#e8423b'; g.fillRect(22, 26, 92, 30); g.restore();
    rr(g, 22, 26, 92, 124, 6); ink(g, null, 4);
    text(g, 'MON', 68, 50, { font: DISP, size: 20, align: 'center', color: '#fff', weight: '', maxW: 80 });
    circle(g, 54, 92, 3.5, INK, 0); circle(g, 82, 92, 3.5, INK, 0);
    g.beginPath(); g.arc(68, 128, 14, Math.PI + 0.5, -0.5); ink(g, null, 3);
    text(g, 'WEEKEND.EXE', 134, 58, { font: DISP, size: 36, color: '#ff7ab8', weight: '', maxW: 350 });
    progress(g, 134, 74, 352, 36, 0, '#ff7ab8');
    rr(g, 139, 79, 26, 26, 13); g.fillStyle = '#ff7ab8'; g.fill();
    text(g, 'Downloading... 2%', 134, 140, { size: 28, color: '#fff', maxW: 300 });
    text(g, 'Time left: 4 days 23 hours', 134, 164, { size: 20, color: '#a9a3c9', weight: '500', maxW: 350 });
  } },
  { id: 'fridge', draw(g) {
    bg(g, '#9fd3ff');
    rr(g, 22, 14, 96, 158, 10); ink(g, '#f4f6f8', 4);
    stroke(g, [22, 64, 118, 64], 3);
    stroke(g, [104, 28, 104, 50], 5); stroke(g, [104, 80, 104, 124], 5);
    rr(g, 34, 80, 54, 34, 4); ink(g, '#1d2540', 2.5);
    text(g, 'TOS', 61, 103, { font: DISP, size: 15, align: 'center', color: '#29f0e0', weight: '', maxW: 46 });
    rr(g, 52, 128, 22, 18, 3); ink(g, '#ffd23a', 2.5); g.beginPath(); g.arc(63, 128, 7, Math.PI, 0); ink(g, null, 2.5);
    dialog(g, 136, 16, 356, 150, 'Smart Fridge OS', '#2f6fd8');
    text(g, 'Accept the new Terms', 152, 76, { size: 28, maxW: 326 });
    text(g, 'to open the door.', 152, 108, { size: 28, maxW: 326 });
    button(g, 152, 124, 190, 32, 'Accept (412 pages)', true);
    button(g, 354, 124, 122, 32, 'Starve');
  } },
  { id: 'ai-cat', draw(g) {
    bg(g, '#121726');
    g.save(); rr(g, 18, 16, 270, 148, 6); g.clip();
    g.fillStyle = grad(g, ['#bfe8ff', '#e6f6ff'], 0, 16, 0, 100); g.fillRect(18, 16, 270, 90);
    g.fillStyle = '#7cc46a'; g.fillRect(18, 104, 270, 60);
    gator(g, 148, 134, 0.85);
    g.restore();
    rr(g, 18, 16, 270, 148, 6); ink(g, null, 4, '#3a3d46');
    g.save(); g.setLineDash([8, 6]); g.strokeStyle = '#b6ff3a'; g.lineWidth = 3; g.strokeRect(62, 82, 208, 74); g.restore();
    g.fillStyle = '#b6ff3a'; g.fillRect(62, 60, 104, 22);
    text(g, 'CAT  98%', 114, 77, { font: DISP, size: 16, align: 'center', weight: '', maxW: 96 });
    text(g, 'NEW AI CAMERA', 304, 50, { font: DISP, size: 24, color: '#29f0e0', weight: '', maxW: 192 });
    text(g, '"98% sure', 304, 94, { size: 32, color: '#fff', maxW: 192 });
    text(g, 'it\'s a cat."', 304, 128, { size: 32, color: '#fff', maxW: 192 });
    text(g, 'Please do not pet.', 304, 158, { size: 20, color: '#ff8a96', weight: '500', maxW: 192 });
  } },
  { id: 'car-update', draw(g) {
    bg(g, '#16181d');
    circle(g, 82, 96, 56, null, 12);
    g.beginPath(); g.arc(82, 96, 56, 0, PI2); ink(g, null, 8, '#3a3d46');
    for (const a of [Math.PI / 2, Math.PI * 1.1, -Math.PI * 0.1]) stroke(g, [82, 96, 82 + Math.cos(a) * 52, 96 + Math.sin(a) * 52], 7, '#3a3d46');
    circle(g, 82, 96, 15, '#2a2c33', 3);
    rr(g, 156, 16, 336, 148, 12); ink(g, '#0e1a2e', 4, '#3a3d46');
    text(g, 'SOFTWARE UPDATE', 174, 50, { font: DISP, size: 22, color: '#29f0e0', weight: '', maxW: 300 });
    text(g, 'Installing 1 of 347...', 174, 88, { size: 28, color: '#fff', maxW: 300 });
    progress(g, 174, 100, 300, 26, 0, '#29d16a');
    rr(g, 179, 105, 18, 16, 8); g.fillStyle = '#29d16a'; g.fill();
    text(g, 'Doors unlock in: 4 hours', 174, 152, { size: 22, color: '#ff8a96', weight: '500', maxW: 300 });
  } },
  { id: 'moon-exit', draw(g) {
    hwySign(g);
    rr(g, 312, 18, 182, 36, 6); ink(g, '#ffd23a', 3);
    text(g, 'EXIT  -98%', 403, 45, { font: DISP, size: 24, align: 'center', weight: '', maxW: 166 });
    arrow(g, 64, 154, 64, 46, '#fff', 14, 34);
    text(g, 'TO THE MOON', 112, 104, { font: DISP, size: 40, color: '#fff', weight: '', maxW: 290 });
    text(g, '238,900 mi', 114, 146, { size: 32, color: '#fff', maxW: 200 });
    circle(g, 452, 112, 30, '#fff6c0', 0); circle(g, 466, 102, 26, '#1d6b3f', 0);
    text(g, 'crypto bros only', 452, 166, { size: 13, align: 'center', color: '#bfe3c9', weight: '500', maxW: 100 });
  } },
  { id: 'ice-cream', draw(g) {
    bg(g, '#ffd6ea');
    sun(g, 474, 38, 16, true);
    text(g, 'FREE ICE CREAM*', 22, 62, { font: DISP, size: 40, color: '#d6307a', weight: '', maxW: 340 });
    text(g, '*if you finish it in', 24, 104, { size: 28, maxW: 320 });
    text(g, '3 seconds. It\'s 98°F.', 24, 140, { size: 28, maxW: 320 });
    g.beginPath(); g.ellipse(414, 166, 46, 9, 0, 0, PI2); ink(g, '#ffb3d1', 3);
    poly(g, [384, 96, 444, 96, 414, 164], '#e8b46a');
    for (let i = 0; i < 4; i++) { stroke(g, [390 + i * 12, 100, 410 + i * 6, 150], 1.5, '#b07a3a'); stroke(g, [438 - i * 12, 100, 418 - i * 6, 150], 1.5, '#b07a3a'); }
    g.beginPath(); g.moveTo(380, 98); g.arc(414, 86, 34, Math.PI * 0.95, Math.PI * 0.05);
    g.lineTo(452, 108); g.quadraticCurveTo(454, 128, 448, 130); g.quadraticCurveTo(442, 128, 444, 104);
    g.lineTo(404, 104); g.lineTo(400, 140); g.quadraticCurveTo(394, 146, 390, 138); g.lineTo(388, 104); g.closePath(); ink(g, '#ff8fc7', 3);
    circle(g, 404, 76, 4, '#fff', 0);
  } },
  { id: 'gob-sale', draw(g) {
    bg(g, '#e9e2d4');
    rr(g, 18, 16, 476, 56, 6); ink(g, '#ffd23a', 4);
    text(g, 'GOING OUT OF BUSINESS!', 256, 56, { font: DISP, size: 34, align: 'center', color: '#d6302a', weight: '', maxW: 452 });
    text(g, 'EVERYTHING MUST GO!', 24, 110, { size: 28, maxW: 290 });
    text(g, 'Since 1987.', 22, 156, { font: DISP, size: 40, weight: '', maxW: 290 });
    rr(g, 330, 84, 164, 86, 3); ink(g, '#c9b9a0', 3);
    rr(g, 342, 96, 70, 50, 2); ink(g, '#cfe4ea', 3);
    withT(g, 377, 121, 1, () => { g.rotate(-0.12); text(g, 'SALE', 0, 6, { font: DISP, size: 16, align: 'center', color: 'rgba(214,48,42,0.45)', weight: '', maxW: 60 }); });
    rr(g, 432, 104, 40, 66, 2); ink(g, '#8a5a2b', 3);
    g.save(); g.strokeStyle = 'rgba(80,80,80,0.6)'; g.lineWidth = 1.2;
    for (let k = 0; k < 5; k++) { g.beginPath(); g.moveTo(494, 84); g.lineTo(494 - 34 * Math.cos(k * 0.39), 84 + 34 * Math.sin(k * 0.39)); g.stroke(); }
    for (const r of [12, 24]) { g.beginPath(); g.arc(494, 84, r, Math.PI / 2, Math.PI); g.stroke(); }
    g.restore();
  } },
  { id: 'lost', draw(g) {
    bg(g, '#c9a16a');
    for (let i = 0; i < 60; i++) circle(g, (i * 89) % AD_W, (i * 47) % AD_H, 1.5, 'rgba(90,60,30,0.35)', 0);
    withT(g, 256, 90, 1, () => {
      g.rotate(-0.015);
      rr(g, -234, -80, 468, 162, 2); ink(g, '#ffffff', 2);
      text(g, 'LOST:', -214, -26, { font: DISP, size: 42, color: '#d6302a', weight: '', maxW: 140 });
      text(g, 'MY PATIENCE', -78, -26, { font: DISP, size: 40, weight: '', maxW: 290 });
      text(g, 'Last seen: stuck in traffic on Highway 1.', -214, 8, { size: 22, weight: '500', maxW: 428 });
      text(g, 'REWARD: one empty lane.', -214, 36, { size: 22, color: '#1e8a4c', maxW: 428 });
      for (let k = 0; k < 10; k++) {
        const x = -234 + k * 46.8;
        if (k) { g.save(); g.setLineDash([3, 4]); stroke(g, [x, 46, x, 82], 1.5, '#9aa0a8'); g.restore(); }
        withT(g, x + 28, 78, 1, () => { g.rotate(-Math.PI / 2); text(g, '555-HONK', 0, 0, { size: 11, maxW: 30, weight: '500' }); });
      }
      stroke(g, [-234, 46, 234, 46], 1.5, '#d0d4da');
      circle(g, 0, -70, 6, '#e8423b', 2);
    });
  } },
  { id: 'nobody-ac', draw(g) {
    bg(g, '#ffffff');
    text(g, 'Nobody:', 24, 46, { size: 32, maxW: 260 });
    text(g, 'Me in Leonida:', 24, 92, { size: 34, maxW: 270, color: '#d6302a' });
    text(g, '*AC on 62°F, wears a hoodie*', 24, 130, { size: 22, maxW: 272, weight: '500', color: '#555' });
    text(g, '(it is 97°F outside)', 24, 160, { size: 20, maxW: 260, color: '#ff8a3d', weight: '500' });
    rr(g, 312, 18, 132, 48, 8); ink(g, '#f4f6f8', 3);
    for (let i = 0; i < 4; i++) stroke(g, [324, 44 + i * 5, 400, 44 + i * 5], 1.5, '#9aa0a8');
    rr(g, 406, 26, 30, 18, 3); ink(g, '#1d2540', 2); text(g, '62°', 421, 40, { font: DISP, size: 12, align: 'center', color: '#29f0e0', weight: '', maxW: 26 });
    for (const [x, y] of [[330, 86], [370, 96], [410, 82], [350, 116]]) {
      g.save(); g.strokeStyle = '#7fc8f0'; g.lineWidth = 2.5; g.lineCap = 'round';
      for (let k = 0; k < 3; k++) { const a = (k * Math.PI) / 3; g.beginPath(); g.moveTo(x - Math.cos(a) * 7, y - Math.sin(a) * 7); g.lineTo(x + Math.cos(a) * 7, y + Math.sin(a) * 7); g.stroke(); }
      g.restore();
    }
    person(g, 450, 172, 0.95, { color: '#3f6fd8', face: 'flat', arms: [-14, -52, 14, -52] });
    g.beginPath(); g.arc(450, 172 - 86 * 0.95, 19, Math.PI * 0.8, Math.PI * 2.2); ink(g, null, 7, '#3f6fd8');
    for (const s of [-1, 1]) stroke(g, [450 + s * 26, 104, 450 + s * 32, 110, 450 + s * 26, 116], 2.5);
    rr(g, 444, 104, 14, 14, 3); ink(g, '#ffffff', 2.5);
  } },
];

// "NFT of this billboard": the board contains a framed, smaller copy of itself
function nftBoard(g, depth) {
  bg(g, grad(g, ['#2a0f57', '#8a1fb8'], 0, 0, AD_W, AD_H));
  for (let i = 0; i < 18; i++) star(g, (i * 113) % AD_W, 12 + ((i * 59) % 160), 2 + (i % 3), 'rgba(255,255,255,0.35)');
  text(g, 'NFT OF THIS BILLBOARD', 22, 50, { font: DISP, size: 28, color: '#ffffff', weight: '', maxW: 286 });
  text(g, '$2,400,000', 22, 110, { font: DISP, size: 54, color: '#29f0e0', weight: '', maxW: 286 });
  text(g, 'Screenshot: free.', 24, 156, { size: 32, color: '#ffd23a', maxW: 286 });
  const fx = 326, fy = 36, k = 0.32, fw = AD_W * k, fh = AD_H * k;
  rr(g, fx - 12, fy - 12, fw + 24, fh + 24, 5); ink(g, '#e0ac2a', 4);
  rr(g, fx - 5, fy - 5, fw + 10, fh + 10, 3); ink(g, '#9a6a10', 0);
  if (depth < 2) {
    g.save(); g.translate(fx, fy); g.scale(k, k);
    g.beginPath(); g.rect(0, 0, AD_W, AD_H); g.clip();
    nftBoard(g, depth + 1);
    g.lineWidth = 8; g.strokeStyle = INK; g.strokeRect(4, 4, AD_W - 8, AD_H - 8);
    g.restore();
  } else { g.fillStyle = '#5a1a8a'; g.fillRect(fx, fy, fw, fh); }
  rr(g, 342, 126, 76, 24, 4); ink(g, '#e0ac2a', 3);
  text(g, '#1 of 1', 380, 144, { size: 17, align: 'center', color: '#3a2400', maxW: 66 });
  withT(g, 464, 136, 1, () => {
    g.rotate(-0.22);
    rr(g, -36, -16, 72, 32, 5); ink(g, null, 4, '#ff3b5c');
    text(g, 'SOLD', 0, 10, { font: DISP, size: 24, align: 'center', color: '#ff3b5c', weight: '', maxW: 64 });
  });
}

export const AD_IDS = ADS.map((a) => a.id);
if (ADS.length > AD_COLS * AD_ROWS) console.warn('[life] ad atlas too small for', ADS.length, 'ads');

// Atlas resolution per quality preset: every meme is authored in AD_W x AD_H units and scaled into its cell.
// GPU memory of the atlas (RGBA8 + mip chain, 4 x 17 cells): 1 → 2048x3060 ≈ 33 MB, 0.875 → 1792x2686 ≈ 26 MB,
// 0.75 → 1536x2295 ≈ 19 MB, 0.625 → 1280x1921 ≈ 13 MB. The 2D canvas is released after each upload.
export const AD_SCALE = { ultra: 1, high: 1, medium: 0.875, low: 0.75, mobile: 0.625 };

export function adAtlasScale(name, mobile = false, maxTex = 4096) {
  const s = mobile ? Math.min(AD_SCALE.mobile, AD_SCALE[name] ?? 1) : (AD_SCALE[name] ?? 1);
  return Math.min(s, maxTex / (AD_COLS * AD_W), maxTex / (AD_ROWS * AD_H));
}

export function drawAdAtlas(canvas, scale = 1) {
  const cw = Math.round(AD_W * scale), ch = Math.round(AD_H * scale);
  canvas.width = AD_COLS * cw;
  canvas.height = AD_ROWS * ch;
  const g = canvas.getContext('2d');
  ADS.forEach((ad, i) => {
    g.save();
    g.translate((i % AD_COLS) * cw, Math.floor(i / AD_COLS) * ch);
    g.scale(cw / AD_W, ch / AD_H);
    g.beginPath(); g.rect(0, 0, AD_W, AD_H); g.clip();
    try { ad.draw(g); } catch (e) { console.warn('[life] ad', ad.id, e); }
    g.lineWidth = 6; g.strokeStyle = INK; g.strokeRect(3, 3, AD_W - 6, AD_H - 6); // board trim
    g.restore();
  });
}

// UV origin of ad cell i (texture flipY = true → row 0 is at the top of the canvas)
export function adCell(i) {
  const c = i % AD_COLS, r = Math.floor(i / AD_COLS) % AD_ROWS;
  return [c / AD_COLS, 1 - (r + 1) / AD_ROWS];
}

// Drawn once at init and once more when the web fonts arrive. After each GPU upload the canvas is shrunk to 1x1 so
// its backing store (as big as the texture) is freed; a lost WebGL context gets a fresh redraw on restore.
export function makeAdTexture(renderer, scale = 1) {
  const canvas = document.createElement('canvas');
  const draw = () => drawAdAtlas(canvas, scale);
  draw();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() || 4);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.onUpdate = () => { canvas.width = canvas.height = 1; };
  whenFontsReady(() => { draw(); tex.needsUpdate = true; });
  renderer?.domElement?.addEventListener?.('webglcontextrestored', () => { draw(); tex.needsUpdate = true; });
  return tex;
}

// ------------------------------------------------------------------------------------------ neon word atlas
export const NEON_WORDS = ['HOTEL', 'MOTEL', 'OPEN', 'DINER', 'CAFE', 'DISCO', 'SURF', 'PIZZA'];
const NW = 128, NH = 480;

function drawNeon(canvas) {
  canvas.width = NW * NEON_WORDS.length;
  canvas.height = NH;
  const g = canvas.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, canvas.width, canvas.height);
  NEON_WORDS.forEach((w, i) => {
    const x = i * NW + NW / 2;
    const n = w.length;
    const step = Math.min(92, (NH - 40) / n);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `${Math.floor(step * 0.95)}px ${DISP}`;
    g.strokeStyle = '#fff'; g.lineWidth = 4; g.shadowColor = '#fff'; g.shadowBlur = 14;
    rr(g, i * NW + 10, 10, NW - 20, NH - 20, 18); g.stroke();
    for (let k = 0; k < n; k++) {
      const y = NH / 2 + (k - (n - 1) / 2) * step;
      g.shadowBlur = 22; g.fillStyle = '#fff'; g.fillText(w[k], x, y);
      g.shadowBlur = 0; g.fillStyle = 'rgba(255,255,255,0.95)'; g.fillText(w[k], x, y);
    }
  });
  g.shadowBlur = 0;
}

export function makeNeonTexture() {
  const canvas = document.createElement('canvas');
  drawNeon(canvas);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  whenFontsReady(() => { drawNeon(canvas); tex.needsUpdate = true; });
  return tex;
}

export function neonCell(i) { return [(i % NEON_WORDS.length) / NEON_WORDS.length, 0]; }
