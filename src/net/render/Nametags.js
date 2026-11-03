// Nametags in WebGL: a canvas text atlas + one instanced quad per visible tag (single draw call, no DOM per player).
// Screen-facing and constant-size in CSS pixels, depth-tested at the anchor (walls and hills hide them), faded with
// distance; only the nearest MAX tags within RANGE metres are drawn. The atlas slot is only redrawn when the name,
// colour or vehicle icon of a player changes.
import * as THREE from 'three';
import { PLAYER_COLORS, VCLASS } from '../shared/constants.js';
import { nickName } from '../shared/nicknames.js';

const TAG_SCALE = 1.5; // on-screen size ×1.5 (base 128×20 CSS px was too small); the 256×40 atlas cell still covers it
const SW = 256, SH = 40, COLS = 4, ROWS = 12, MAX_SLOTS = COLS * ROWS;
const MAX = 32, RANGE = 180, FADE_FROM = 130;
const LIFT = { [VCLASS.FOOT]: 2.15, [VCLASS.CAR]: 2.2, [VCLASS.BIKE]: 2.1, [VCLASS.HELI]: 4.2, [VCLASS.PLANE]: 4.5, [VCLASS.BOAT]: 3.2 };

const VERT = /* glsl */`
attribute vec3 iPos;
attribute vec4 iUv;
attribute float iAlpha;
attribute float iScale;
uniform vec2 uScreen;
varying vec2 vUv;
varying float vA;
void main() {
  vec4 clip = projectionMatrix * viewMatrix * vec4(iPos, 1.0);
  vec2 size = vec2(${SW / 2}.0, ${SH / 2}.0) * iScale;
  clip.xy += position.xy * size * 2.0 / uScreen * clip.w;
  gl_Position = clip;
  vUv = mix(iUv.xy, iUv.zw, position.xy + 0.5);
  vA = iAlpha;
}`;
const FRAG = /* glsl */`
uniform sampler2D uAtlas;
varying vec2 vUv;
varying float vA;
void main() {
  vec4 c = texture2D(uAtlas, vUv);
  float a = c.a * vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(c.rgb, a);
}`;

export class Nametags {
  constructor(game) {
    this.game = game;
    this.canvas = document.createElement('canvas');
    this.canvas.width = SW * COLS;
    this.canvas.height = SH * ROWS;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.generateMipmaps = false;
    this.tex.minFilter = THREE.LinearFilter;
    this.dirty = false;
    this.uploadT = 0;
    this.slots = new Array(MAX_SLOTS).fill(null); // { id, used, nick, name, color, vclass }
    this.slotOf = new Map(); // id → slot
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aUv = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
    this.aScale = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iUv', this.aUv);
    geo.setAttribute('iAlpha', this.aAlpha);
    geo.setAttribute('iScale', this.aScale);
    geo.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: true, depthWrite: false,
      uniforms: { uAtlas: { value: this.tex }, uScreen: { value: new THREE.Vector2(1, 1) } },
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'net:nametags';
    game.scene.add(this.mesh);
    this.cand = [];
    this.visible = true;
    this.font = null;
  }

  _slot(e, vclass) {
    let s = this.slotOf.get(e.id);
    if (s !== undefined && this.slots[s]?.id === e.id) {
      const sl = this.slots[s];
      // redraw when the name (generated or custom), colour or vehicle glyph changed (no per-frame allocations)
      if (sl.nick !== e.nickCode || sl.name !== e.name || sl.color !== e.color || sl.vclass !== vclass || sl.away !== !!e.away) {
        sl.nick = e.nickCode; sl.name = e.name; sl.color = e.color; sl.vclass = vclass; sl.away = !!e.away;
        this._draw(s, e, vclass);
      }
      sl.used = this.frame;
      return s;
    }
    // free or least recently used slot
    let best = -1, oldest = Infinity;
    for (let i = 0; i < MAX_SLOTS; i++) {
      const sl = this.slots[i];
      if (!sl) { best = i; break; }
      if (sl.used < oldest && sl.used < this.frame) { oldest = sl.used; best = i; }
    }
    if (best < 0) return -1;
    if (this.slots[best]) this.slotOf.delete(this.slots[best].id);
    this.slots[best] = { id: e.id, used: this.frame, nick: e.nickCode, name: e.name, color: e.color, vclass, away: !!e.away };
    this.slotOf.set(e.id, best);
    this._draw(best, e, vclass);
    return best;
  }

  _draw(s, e, vclass) {
    const x = this.ctx, ox = (s % COLS) * SW, oy = Math.floor(s / COLS) * SH;
    if (!this.font) this.font = this.game.i18n?.font?.('ui') || "'Oswald', 'Arial Narrow', Arial, sans-serif";
    x.clearRect(ox, oy, SW, SH);
    const name = (e.name || nickName(e.nickCode)) + (e.away ? ' · AFK' : ''); // canvas text: never markup
    x.font = `600 24px ${this.font}`;
    const tw = Math.min(SW - 64, x.measureText(name).width);
    const w = tw + 58, left = ox + (SW - w) / 2, top = oy + 4, h = SH - 8;
    x.fillStyle = 'rgba(8,8,12,0.62)';
    x.beginPath();
    x.roundRect ? x.roundRect(left, top, w, h, h / 2) : x.rect(left, top, w, h);
    x.fill();
    const col = PLAYER_COLORS[e.color % PLAYER_COLORS.length];
    x.fillStyle = col;
    x.beginPath();
    x.arc(left + 16, oy + SH / 2, 7, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = '#fff';
    x.textBaseline = 'middle';
    x.shadowColor = 'rgba(0,0,0,0.8)';
    x.shadowBlur = 3;
    x.fillText(name, left + 30, oy + SH / 2 + 1, SW - 64);
    x.shadowBlur = 0;
    // vehicle / on-foot glyph
    x.save();
    x.translate(left + w - 16, oy + SH / 2);
    x.strokeStyle = 'rgba(255,255,255,0.8)';
    x.fillStyle = 'rgba(255,255,255,0.8)';
    x.lineWidth = 2;
    icon(x, vclass);
    x.restore();
    this.dirty = true;
  }

  /** entities: interpolated RemoteStore list; cam: THREE camera. */
  update(entities, dt) {
    this.frame = (this.frame || 0) + 1;
    const g = this.game, cam = g.camera;
    this.material.uniforms.uScreen.value.set(window.innerWidth || 1, window.innerHeight || 1);
    const cand = this.cand;
    cand.length = 0;
    if (this.visible) {
      const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e.hasInfo || e.alpha <= 0.02 || !e.hasCurve) continue;
        const d = Math.hypot(e.x - cx, e.y - cy, e.z - cz);
        if (d > RANGE) continue;
        e.dist = d;
        cand.push(e);
      }
      if (cand.length > MAX) cand.sort((a, b) => a.dist - b.dist).length = MAX;
    }
    let n = 0;
    const scaleBase = Math.min(1.15, Math.max(0.75, (g.settings?.hudScale ?? 1)));
    for (const e of cand) {
      const vclass = e.vclass || 0;
      const s = this._slot(e, vclass);
      if (s < 0) continue;
      const u0 = ((s % COLS) * SW) / (SW * COLS), u1 = u0 + SW / (SW * COLS);
      const v1 = 1 - (Math.floor(s / COLS) * SH) / (SH * ROWS), v0 = v1 - SH / (SH * ROWS);
      this.aPos.setXYZ(n, e.x, e.y + (LIFT[vclass] ?? 2.2), e.z);
      this.aUv.setXYZW(n, u0, v0, u1, v1);
      const fade = e.dist < FADE_FROM ? 1 : Math.max(0, 1 - (e.dist - FADE_FROM) / (RANGE - FADE_FROM));
      this.aAlpha.setX(n, fade * e.alpha);
      this.aScale.setX(n, TAG_SCALE * scaleBase * Math.max(0.8, 1 - e.dist / 500));
      n++;
    }
    this.mesh.geometry.instanceCount = n;
    this.aPos.needsUpdate = this.aUv.needsUpdate = this.aAlpha.needsUpdate = this.aScale.needsUpdate = true;
    // throttle atlas uploads (a 1 MB texture): at most 5 per second
    this.uploadT -= dt;
    if (this.dirty && this.uploadT <= 0) { this.tex.needsUpdate = true; this.dirty = false; this.uploadT = 0.2; }
  }

  setVisible(v) { this.visible = v; this.mesh.visible = v; }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.tex.dispose();
  }
}

function icon(x, vclass) {
  x.beginPath();
  if (vclass === VCLASS.FOOT) {
    x.arc(0, -7, 3, 0, Math.PI * 2); x.fill();
    x.beginPath(); x.moveTo(0, -3); x.lineTo(0, 4); x.moveTo(-5, 0); x.lineTo(5, 0); x.moveTo(0, 4); x.lineTo(-4, 10); x.moveTo(0, 4); x.lineTo(4, 10); x.stroke();
  } else if (vclass === VCLASS.PLANE) {
    x.moveTo(0, -10); x.lineTo(0, 10); x.moveTo(-9, 1); x.lineTo(9, 1); x.moveTo(-4, 8); x.lineTo(4, 8); x.stroke();
  } else if (vclass === VCLASS.HELI) {
    x.moveTo(-10, -7); x.lineTo(10, -7); x.stroke(); x.beginPath(); x.ellipse(0, 1, 6, 5, 0, 0, Math.PI * 2); x.fill();
  } else if (vclass === VCLASS.BOAT) {
    x.moveTo(-10, 1); x.lineTo(10, 1); x.lineTo(6, 7); x.lineTo(-6, 7); x.closePath(); x.fill();
  } else if (vclass === VCLASS.BIKE) {
    x.arc(-6, 4, 4, 0, Math.PI * 2); x.moveTo(10, 4); x.arc(6, 4, 4, 0, Math.PI * 2); x.moveTo(-6, 4); x.lineTo(0, -4); x.lineTo(6, 4); x.stroke();
  } else {
    x.moveTo(-10, 4); x.lineTo(-10, -1); x.lineTo(-6, -6); x.lineTo(6, -6); x.lineTo(10, -1); x.lineTo(10, 4); x.closePath(); x.fill();
  }
}
