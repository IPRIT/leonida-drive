// Bounded screen-space player overlay shared by the map and radar. One pass over
// the network's reused blips; at most `budget` markers and `labelBudget` labels.
export class PlayerOverlay {
  constructor(drawArrow, { budget = 160, labelBudget = 48, small = false } = {}) {
    this.arrow = drawArrow;
    this.budget = budget;
    this.labelBudget = labelBudget;
    this.small = small;
    this.cells = Array.from({ length: budget }, () => ({ n: 0 }));
    this.active = [];
    this.boxes = [];
    this.widths = new Map();
  }

  layout(players, v) {
    this.active.length = 0;
    for (const c of this.cells) c.n = 0;
    const cols = Math.max(1, Math.min(this.budget, Math.floor(Math.sqrt(this.budget * v.w / v.h))));
    const rows = Math.max(1, Math.floor(this.budget / cols));
    const cw = v.w / cols, ch = v.h / rows, co = Math.cos(v.rot || 0), si = Math.sin(v.rot || 0);
    const ox = v.ox ?? v.w / 2, oy = v.oy ?? v.h / 2;
    for (const p of players) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      const dx = (p.x - v.cx) / v.mpp, dz = (p.z - v.cz) / v.mpp;
      const x = ox + co * dx - si * dz, y = oy + si * dx + co * dz;
      if (x < 0 || y < 0 || x >= v.w || y >= v.h) continue;
      const c = this.cells[Math.floor(y / ch) * cols + Math.floor(x / cw)];
      if (!c.n) {
        c.p = p; c.x = x; c.y = y;
        c.x0 = c.x1 = p.x; c.z0 = c.z1 = p.z;
        this.active.push(c);
      } else {
        c.x0 = Math.min(c.x0, p.x); c.x1 = Math.max(c.x1, p.x);
        c.z0 = Math.min(c.z0, p.z); c.z1 = Math.max(c.z1, p.z);
        // Stable representative: network packet order never makes a group flicker.
        if (p.id < c.p.id) { c.p = p; c.x = x; c.y = y; }
      }
      c.n++;
    }
    return this.active;
  }

  draw(ctx, players, v) {
    const groups = this.layout(players, v), small = this.small;
    this.boxes.length = 0;
    ctx.save();
    ctx.font = `500 ${small ? 10 : 12}px Oswald, "Arial Narrow", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const c of groups) {
      this.arrow(ctx, c.x, c.y, (v.rot || 0) + (c.p.heading || 0), small ? 6 : 8, c.p.color || '#4fd1ff');
      if (c.n > 1) {
        const x = c.x + 11, y = c.y - 10, text = String(c.n);
        ctx.fillStyle = '#132332';
        ctx.beginPath(); ctx.roundRect(x - 4 - text.length * 3, y - 8, 8 + text.length * 6, 16, 7); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(text, x, y);
      }
    }
    let labels = 0;
    for (const c of groups) {
      if (c.n !== 1 || !c.p.name || labels >= this.labelBudget) continue;
      const name = Array.from(c.p.name).slice(0, 24).join('');
      let width = this.widths.get(name);
      if (width === undefined) {
        width = Math.min(small ? 108 : 180, ctx.measureText(name).width) + 10;
        if (this.widths.size >= 512) this.widths.clear();
        this.widths.set(name, width);
      }
      const x = Math.max(width / 2 + 2, Math.min(v.w - width / 2 - 2, c.x)), y = c.y - (small ? 18 : 21);
      if (y < 10 || Math.hypot(x - (v.ox ?? v.w / 2), y - (v.oy ?? v.h / 2)) < 24) continue;
      const box = [x - width / 2, y - 9, x + width / 2, y + 9];
      if (this.boxes.some((b) => box[0] < b[2] + 3 && box[2] > b[0] - 3 && box[1] < b[3] + 3 && box[3] > b[1] - 3)) continue;
      this.boxes.push(box); labels++;
      ctx.fillStyle = 'rgba(9,18,29,.86)';
      ctx.beginPath(); ctx.roundRect(box[0], box[1], width, 18, 5); ctx.fill();
      ctx.fillStyle = c.p.color || '#c5f2ff';
      ctx.fillText(name, x, y, width - 10);
    }
    ctx.restore();
  }

  hit(x, y) {
    return this.active.find((c) => c.n > 1 && Math.hypot(c.x - x, c.y - y) < 22);
  }
}
