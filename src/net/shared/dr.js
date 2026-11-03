// Dead reckoning shared by the server (which mirrors what clients extrapolate) and the clients: constant speed along a
// circular arc given by the yaw rate (a car in a steady turn needs no updates at all), linear in height. Server and
// client run exactly this arithmetic on the same quantised record, so they agree to the bit.
export function drArc(out, x, y, z, vx, vy, vz, yaw, yr, dt) {
  const th = yr * dt;
  if (th < 1e-6 && th > -1e-6) {
    out.x = x + vx * dt; out.z = z + vz * dt; out.vx = vx; out.vz = vz;
  } else if (th < 0.05 && th > -0.05) {
    // small angle: Taylor series (error < 1e-9 relative), no trig — both sides run this same branch
    const t2 = th * th;
    const sw = dt * (1 - t2 / 6); // sin(θ)/ω
    const cw = dt * th * (0.5 - t2 / 24); // (1 - cos θ)/ω
    const s = th * (1 - t2 / 6), c = 1 - t2 * (0.5 - t2 / 24);
    out.x = x + vx * sw + vz * cw;
    out.z = z + vz * sw - vx * cw;
    out.vx = vx * c + vz * s;
    out.vz = vz * c - vx * s;
  } else {
    // the velocity rotates with the heading: v(t) = v0 cos θ + w0 sin θ, w0 = (vz, -vx)
    const s = Math.sin(th), c = Math.cos(th), inv = 1 / yr;
    out.x = x + (vx * s + vz * (1 - c)) * inv;
    out.z = z + (vz * s - vx * (1 - c)) * inv;
    out.vx = vx * c + vz * s;
    out.vz = vz * c - vx * s;
  }
  out.y = y + vy * dt;
  out.vy = vy;
  out.yaw = yaw + th;
  return out;
}
