// Player car durability: wraps E's per-vehicle damage state (src/damage/VehicleDamage.js) on full-physics Vehicles.
// - Health lives in st.__hp (0..1) and is mapped onto E's engine scale, whose thresholds drive smoke (< 0.6 light,
//   < 0.35 dark + limp), the fuel leak (< 0.3) and ignition (<= 0.15): no smoke above 25 % health, fire below ~6 %.
// - Crash damage while the player drives: small knocks are ignored and the rest takes 0.75× health; the "instant
//   fire" rule for a huge hit needs a bigger one. Dents, panels, glass and lamps still get the full energy.
// - Explosions (and the net's server-resolved hits, which arrive as explosions) are untouched: the engine loss E
//   applies is taken 1:1 as health loss. Fires burn 1.8× longer before the car blows up.
// Other code that writes st.engine directly (repair, taken-over traffic dents, Services) is picked up on the next call.
import * as THREE from 'three';

export const DURABILITY = {
  crashScale: 0.75, // health loss per crash vs the stock rate
  minE: 0.1, // impact energy ignored (≈ 2 m/s of extra Δv over E's threshold)
  instantFireE: 1.25, // stock 1.05 (≈ 94 vs 81 km/h of Δv)
  smokeAt: 0.25, // health below which smoke shows (engine 0.6)
  fireAt: 0.06, // health at which the car catches fire (engine 0.15)
  fuseScale: 1.8,
};

const D = DURABILITY;
const ENG_SMOKE = 0.6, ENG_FIRE = 0.15;

/** health → E's engine value */
export function hpToEngine(hp) {
  if (hp >= D.smokeAt) return ENG_SMOKE + ((1 - ENG_SMOKE) * (hp - D.smokeAt)) / (1 - D.smokeAt);
  if (hp >= D.fireAt) return ENG_FIRE + ((ENG_SMOKE - ENG_FIRE) * (hp - D.fireAt)) / (D.smokeAt - D.fireAt);
  return Math.max(0, (ENG_FIRE * hp) / D.fireAt);
}

/** E's engine value → health */
export function engineToHp(e) {
  if (e >= ENG_SMOKE) return D.smokeAt + ((1 - D.smokeAt) * (e - ENG_SMOKE)) / (1 - ENG_SMOKE);
  if (e >= ENG_FIRE) return D.fireAt + ((D.smokeAt - D.fireAt) * (e - ENG_FIRE)) / (ENG_SMOKE - ENG_FIRE);
  return Math.max(0, (D.fireAt * e) / ENG_FIRE);
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Patch a VehicleDamage instance once. `v` is the Vehicle (its `occupied` flag marks the player's car). */
export function patchDurability(v, st) {
  if (!st || st.__tough) return;
  st.__tough = true;
  st.__hp = engineToHp(st.engine);
  st.__eng = st.engine;
  // someone else wrote st.engine (repair, takeover, a blast inside E's code): adopt it
  const sync = () => {
    if (st.engine !== st.__eng) { st.__hp = engineToHp(st.engine); st.__eng = st.engine; }
  };
  const write = (hp) => {
    st.__hp = clamp01(hp);
    if (st.state === 'ok') st.engine = hpToEngine(st.__hp);
    st.__eng = st.engine;
  };
  const impact = st.applyImpact, blast = st.applyExplosion, ignite = st.ignite;
  st.applyImpact = function (pointW, inwardW, e, info = {}) {
    sync();
    const crash = info.explosion === undefined && v.occupied;
    const hp0 = st.__hp;
    const eng0 = st.engine;
    impact.call(this, pointW, inwardW, e, info);
    if (crash && this.state === 'ok') {
      // own health model: E's proximity weighting, scaled down and thresholded
      let prox = 1;
      try {
        const pl = this._toLocal(pointW, _p);
        prox = 1 - clamp01(pl.distanceTo(this.enginePos) / (this.size.z * 0.6));
      } catch { /* keep worst case */ }
      const loss = Math.max(0, e - D.minE) * (0.3 + 0.7 * prox) * 0.425 * D.crashScale;
      let hp = hp0 - loss;
      if (e > D.instantFireE && this.flammable) hp = Math.min(hp, D.fireAt * 0.9);
      write(hp);
    } else if (this.state === 'ok') {
      // explosions / parked car: E's engine loss counts 1:1 as health loss
      write(hp0 - Math.max(0, eng0 - this.engine));
    } else st.__eng = st.engine;
  };
  st.applyExplosion = function (...a) {
    sync();
    const hp0 = st.__hp, eng0 = st.engine;
    // applyExplosion calls applyImpact (counted there); this catches its own direct engine loss
    blast.apply(this, a);
    if (this.state === 'ok' && st.__eng !== st.engine) write(Math.min(st.__hp, hp0 - Math.max(0, eng0 - this.engine)));
    else if (this.state !== 'ok') st.__eng = st.engine;
  };
  st.ignite = function (fuse) {
    const base = fuse ?? 6 + Math.random() * 6;
    const r = ignite.call(this, base * D.fuseScale);
    st.__eng = st.engine;
    return r;
  };
}

const _p = new THREE.Vector3();
