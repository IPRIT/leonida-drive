// GPS route rendering shared by the radar and the full map: a smooth line through the road-following route
// points (quadratic splines through segment midpoints), soft glow, dark casing, purple core and white flow dashes
// that move towards the destination. Call with the world -> device transform set; `unit` = world metres per CSS
// px. Allocation-free.

const DASH = [0, 0];
const NO_DASH = [];

export const ROUTE_STYLE = {
  map: { glow: 16, casing: 8.5, core: 5, flow: 2, dash: 7, gap: 15, speed: 26 },
  radar: { glow: 13, casing: 7.2, core: 4.4, flow: 1.6, dash: 6, gap: 13, speed: 22 },
};

// nearest route point to (x, z) among the first `limit` points (the route starts where it was computed)
export function nearestRouteIndex(route, x, z, limit = 600) {
  let best = 0, bd = Infinity;
  const n = Math.min(route.length >> 1, limit);
  for (let i = 0; i < n; i++) {
    const dx = route[i * 2] - x, dz = route[i * 2 + 1] - z;
    const d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// last route point within a square of half-size r around (x, z), scanning from i0
export function lastRouteIndexWithin(route, i0, x, z, r) {
  let last = i0;
  const n = route.length >> 1;
  for (let i = i0; i < n; i++) {
    if (Math.abs(route[i * 2] - x) < r && Math.abs(route[i * 2 + 1] - z) < r) last = i;
  }
  return Math.min(n - 1, last + 1);
}

function tracePath(ctx, route, i0, i1) {
  ctx.beginPath();
  ctx.moveTo(route[i0 * 2], route[i0 * 2 + 1]);
  if (i1 - i0 < 2) { ctx.lineTo(route[i1 * 2], route[i1 * 2 + 1]); return; }
  for (let i = i0 + 1; i < i1; i++) {
    const x = route[i * 2], z = route[i * 2 + 1];
    if (i === i1 - 1) ctx.quadraticCurveTo(x, z, route[i1 * 2], route[i1 * 2 + 1]);
    else ctx.quadraticCurveTo(x, z, (x + route[i * 2 + 2]) * 0.5, (z + route[i * 2 + 3]) * 0.5);
  }
}

// draws points i0..i1 (point indices, inclusive). time: seconds (animates the flow).
export function strokeRoute(ctx, route, i0, i1, unit, time, st) {
  if (!route || i1 <= i0) return;
  tracePath(ctx, route, i0, i1);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash(NO_DASH);
  ctx.strokeStyle = 'rgba(201, 92, 255, 0.22)';
  ctx.lineWidth = st.glow * unit;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(28, 4, 48, 0.92)';
  ctx.lineWidth = st.casing * unit;
  ctx.stroke();
  ctx.strokeStyle = '#c95cff';
  ctx.lineWidth = st.core * unit;
  ctx.stroke();
  // flow: dashes travel from the player towards the destination
  DASH[0] = st.dash * unit;
  DASH[1] = st.gap * unit;
  ctx.setLineDash(DASH);
  ctx.lineDashOffset = -((time * st.speed) % (st.dash + st.gap)) * unit;
  ctx.strokeStyle = 'rgba(255, 238, 255, 0.75)';
  ctx.lineWidth = st.flow * unit;
  ctx.stroke();
  ctx.setLineDash(NO_DASH);
  ctx.lineDashOffset = 0;
}
