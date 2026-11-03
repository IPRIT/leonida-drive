import * as THREE from 'three';

// Lightweight HDR bloom (dual-filter style): threshold + downsample to ½, then ¼ … 1/32, then tent
// upsampling added back up the chain. ~0.3 MP of work at 1080p; the result (½ res) is added in the final
// pass, so there is no extra full-screen composite.

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

const PREFILTER = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uThreshold, uKnee;
  varying vec2 vUv;
  vec3 pre(vec3 c) {
    if (any(isnan(c)) || any(isinf(c))) return vec3(0.0);
    c = min(c, vec3(64.0));
    float br = max(c.r, max(c.g, c.b));
    float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-4);
    float w = max(soft, br - uThreshold) / max(br, 1e-4);
    return c * w;
  }
  void main() {
    vec2 o = uTexel * 0.5;
    vec3 a = pre(texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb), b = pre(texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb);
    vec3 c = pre(texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb), d = pre(texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb);
    // Karis average: suppresses single-pixel fireflies (sun glints)
    float wa = 1.0 / (1.0 + dot(a, vec3(0.3, 0.5, 0.2))), wb = 1.0 / (1.0 + dot(b, vec3(0.3, 0.5, 0.2)));
    float wc = 1.0 / (1.0 + dot(c, vec3(0.3, 0.5, 0.2))), wd = 1.0 / (1.0 + dot(d, vec3(0.3, 0.5, 0.2)));
    gl_FragColor = vec4((a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd), 1.0);
  }
`;

const DOWN = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec2 o = uTexel;
    vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
    s += texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb;
    s += texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb;
    gl_FragColor = vec4(s / 8.0, 1.0);
  }
`;

const UP = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uWeight;
  varying vec2 vUv;
  void main() {
    vec2 o = uTexel;
    vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
    s += (texture2D(tSrc, vUv + vec2(o.x, 0.0)).rgb + texture2D(tSrc, vUv - vec2(o.x, 0.0)).rgb
        + texture2D(tSrc, vUv + vec2(0.0, o.y)).rgb + texture2D(tSrc, vUv - vec2(0.0, o.y)).rgb) * 2.0;
    s += texture2D(tSrc, vUv + o).rgb + texture2D(tSrc, vUv - o).rgb
       + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb + texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb;
    gl_FragColor = vec4(s / 16.0 * uWeight, 1.0);
  }
`;

export class Bloom {
  constructor(levels = 5) {
    this.levels = levels;
    this.threshold = 2.6;
    this.knee = 0.6;
    this.radius = 0.75; // weight of the wider levels
    this.enabled = true;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.rts = Array.from({ length: levels }, () => new THREE.WebGLRenderTarget(1, 1, opts));
    const mk = (frag, uniforms, blending = THREE.NoBlending) => new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: frag, depthTest: false, depthWrite: false, blending });
    this.preMat = mk(PREFILTER, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 2.6 }, uKnee: { value: 0.6 } });
    this.downMat = mk(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.upMat = mk(UP, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } }, THREE.AdditiveBlending);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.preMat);
    this.quad.frustumCulled = false;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.texture = this.rts[0].texture;
  }

  setSize(w, h) {
    this.srcW = w; this.srcH = h;
    for (let i = 0; i < this.levels; i++) this.rts[i].setSize(Math.max(1, Math.round(w / (2 << i))), Math.max(1, Math.round(h / (2 << i))));
  }

  _draw(r, mat, target) {
    this.quad.material = mat;
    r.setRenderTarget(target);
    r.render(this.quad, this.cam);
  }

  render(r, srcTexture) {
    const prevAuto = r.autoClear;
    r.autoClear = false;
    const p = this.preMat.uniforms;
    p.tSrc.value = srcTexture;
    p.uTexel.value.set(1 / this.srcW, 1 / this.srcH);
    p.uThreshold.value = this.threshold;
    p.uKnee.value = this.knee;
    this._draw(r, this.preMat, this.rts[0]);
    const d = this.downMat.uniforms;
    for (let i = 1; i < this.levels; i++) {
      d.tSrc.value = this.rts[i - 1].texture;
      d.uTexel.value.set(1 / this.rts[i - 1].width, 1 / this.rts[i - 1].height);
      this._draw(r, this.downMat, this.rts[i]);
    }
    const u = this.upMat.uniforms;
    for (let i = this.levels - 2; i >= 0; i--) {
      u.tSrc.value = this.rts[i + 1].texture;
      u.uTexel.value.set(1 / this.rts[i + 1].width, 1 / this.rts[i + 1].height);
      u.uWeight.value = this.radius;
      this._draw(r, this.upMat, this.rts[i]);
    }
    r.autoClear = prevAuto;
    return this.texture;
  }

  // compile the programs (used by Renderer.prewarm)
  materials() { return [this.preMat, this.downMat, this.upMat]; }
}
