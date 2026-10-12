'use strict';

/**
 * Hybrid Logical Clock (HLC).
 *
 * Why not plain wall-clock timestamps: devices have skewed clocks, and a device
 * whose clock is behind must never be able to silently overwrite newer data.
 * Why not a pure Lamport clock: we still want "looks like a real time" for
 * human-facing version history and for debugging.
 *
 * HLC keeps (physicalMs, logical) so that:
 *   - hlc is monotonically increasing per device, even if the wall clock jumps back
 *   - hlc is causally consistent: if B saw A's change, B's next hlc > A's hlc
 *   - two devices with skewed clocks still order deterministically
 *
 * Encoding: [physicalMs, logical, deviceId] compared
 *   physicalMs -> logical -> deviceId (lexicographic) -> opId (final tiebreak)
 */

function encodeHlc(physicalMs, logical, deviceId) {
  return { p: physicalMs, l: logical, d: deviceId };
}

/** Total order over HLC stamps; deterministic across all devices. */
function compareHlc(a, b) {
  if (a.p !== b.p) return a.p < b.p ? -1 : 1;
  if (a.l !== b.l) return a.l < b.l ? -1 : 1;
  if (a.d !== b.d) return a.d < b.d ? -1 : 1;
  return 0;
}

class HlcClock {
  /**
   * @param {string} deviceId stable device id
   * @param {() => number} now injectable wall clock (ms since epoch)
   * @param {number} maxDriftMs reject remote stamps further in the future than this
   */
  constructor(deviceId, now = () => Date.now(), maxDriftMs = 60 * 60 * 1000) {
    this.deviceId = deviceId;
    this.now = now;
    this.maxDriftMs = maxDriftMs;
    this.p = 0;
    this.l = 0;
  }

  /** Timestamp for a local event. */
  tick() {
    const wall = this.now();
    if (wall > this.p) {
      this.p = wall;
      this.l = 0;
    } else {
      // clock did not advance, or jumped backwards: keep monotonicity
      this.l += 1;
    }
    return encodeHlc(this.p, this.l, this.deviceId);
  }

  /**
   * Fold a received stamp into the local clock. Returns the (possibly adjusted)
   * stamp we observed, and reports suspected clock skew so the UI can warn.
   */
  observe(remote) {
    const wall = this.now();
    const skewMs = remote.p - wall;
    const suspectedSkew = skewMs > this.maxDriftMs;

    // Use the remote physical time only up to wall + maxDrift, so a device with a
    // clock far in the future cannot push our local clock forward forever.
    const boundedRemoteP = Math.min(remote.p, wall + this.maxDriftMs);
    const maxP = Math.max(this.p, boundedRemoteP);
    if (maxP === this.p && maxP === boundedRemoteP) {
      this.l = Math.max(this.l, remote.l) + 1;
    } else if (maxP === this.p) {
      this.l += 1;
    } else {
      this.l = remote.l + 1;
    }
    this.p = maxP;
    return { suspectedSkew, skewMs, effectiveRemote: encodeHlc(boundedRemoteP, remote.l, remote.d) };
  }
}

module.exports = { encodeHlc, compareHlc, HlcClock };
