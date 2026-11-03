// GPU timing with EXT_disjoint_timer_query_webgl2 (non-nested sections, results arrive 1-3 frames later).
export class GpuTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.available = !!this.ext;
    this.enabled = this.available;
    this.pool = [];
    this.pending = [];
    this._still = [];
    this.current = null;
    this.frame = 0;
    this.results = {}; // name -> smoothed ms
    this.last = {}; // name -> last ms
    this.frameMs = null; // smoothed sum of sections of the last complete frame
    this._frames = new Map(); // frame -> {sum, left, bad}
    this._recs = []; // pooled section records
    this._frec = []; // pooled frame records
  }

  begin(name) {
    if (!this.enabled) return;
    if (this.current) this.end();
    const gl = this.gl;
    const q = this.pool.pop() || gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    const rec = this._recs.pop() || {};
    rec.name = name; rec.q = q; rec.frame = this.frame;
    this.current = rec;
  }

  end() {
    if (!this.current) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.current);
    let f = this._frames.get(this.current.frame);
    if (!f) { f = this._frec.pop() || {}; f.sum = 0; f.left = 0; f.bad = false; this._frames.set(this.current.frame, f); }
    f.left++;
    this.current = null;
  }

  // call once per frame (after rendering)
  tick() {
    if (!this.enabled) return;
    if (this.current) this.end();
    const gl = this.gl, ext = this.ext;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    const still = this._still;
    still.length = 0;
    for (const p of this.pending) {
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) { still.push(p); continue; }
      const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT);
      this.pool.push(p.q);
      this._recs.push(p);
      const f = this._frames.get(p.frame);
      if (disjoint) { if (f) f.bad = true; } else {
        const ms = ns / 1e6;
        this.last[p.name] = ms;
        const prev = this.results[p.name];
        this.results[p.name] = prev == null ? ms : prev + (ms - prev) * 0.1;
        if (f) f.sum += ms;
      }
      if (f && --f.left === 0) {
        if (!f.bad) this.frameMs = this.frameMs == null ? f.sum : this.frameMs + (f.sum - this.frameMs) * 0.15;
        this.lastFrameMs = f.sum;
        this._frames.delete(p.frame);
        this._frec.push(f);
      }
    }
    this._still = this.pending;
    this.pending = still;
    if (this.pending.length > 200) { this.pending.length = 0; this._frames.clear(); }
    this.frame++;
  }

  reset() { this.results = {}; this.last = {}; this.frameMs = null; }
}
