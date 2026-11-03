// Rapier collision group bits (high 16 bits = membership, low 16 bits = filter).
export const GROUPS = Object.freeze({
  GROUND: 0x0001,
  STATIC: 0x0002,
  VEHICLE: 0x0004,
  PROP: 0x0008,
  TRAFFIC: 0x0010,
  CHARACTER: 0x0020,
  PICKUP: 0x0040,
  ALL: 0xffff,
});

/** Pack membership + filter into a Rapier InteractionGroups u32. */
export function groups(membership, filterMask = 0xffff) {
  return (((membership & 0xffff) << 16) | (filterMask & 0xffff)) >>> 0;
}

/** What wheel rays are allowed to stand on. */
export const WHEEL_RAY_MASK = GROUPS.GROUND | GROUPS.STATIC | GROUPS.PROP | GROUPS.TRAFFIC | GROUPS.VEHICLE;
