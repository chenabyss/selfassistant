'use strict';

/**
 * Per-field version vector: { deviceId: counter }.
 *
 * Used to decide, for a single field of a single object, whether an incoming
 * value is newer, older, or *concurrent* with what we already have.
 *
 * Invariant that makes this safe: a device MUST bump its own counter for a field
 * whenever it writes that field, and MUST merge (componentwise max) the incoming
 * vector into the local one whenever it accepts or even just observes a write.
 * That guarantees "causality is captured": if device A's write was seen by B
 * before B wrote, then B's vector dominates A's on that field.
 */

function vvClone(v) {
  return { ...v };
}

/** Componentwise max. */
function vvMerge(a, b) {
  const out = vvClone(a);
  for (const [d, c] of Object.entries(b)) {
    out[d] = Math.max(out[d] || 0, c);
  }
  return out;
}

/** Bump this device's counter. */
function vvBump(v, deviceId) {
  const out = vvClone(v);
  out[deviceId] = (out[deviceId] || 0) + 1;
  return out;
}

/**
 * @returns {'dominates'|'dominated'|'equal'|'concurrent'} how `a` relates to `b`.
 * `a dominates b` means a is newer-or-equal in every component and strictly newer
 * in at least one, i.e. a's write happened after b's write (or saw it).
 */
function vvCompare(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let aGreater = false;
  let bGreater = false;
  for (const k of keys) {
    const av = a[k] || 0;
    const bv = b[k] || 0;
    if (av > bv) aGreater = true;
    else if (bv > av) bGreater = true;
  }
  if (aGreater && bGreater) return 'concurrent';
  if (aGreater) return 'dominates';
  if (bGreater) return 'dominated';
  return 'equal';
}

/** Does `a` causally dominate or equal `b`? (i.e. is b's write an ancestor of a) */
function vvSeen(a, b) {
  const c = vvCompare(a, b);
  return c === 'dominates' || c === 'equal';
}

module.exports = { vvClone, vvMerge, vvBump, vvCompare, vvSeen };
