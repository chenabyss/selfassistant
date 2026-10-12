'use strict';

const crypto = require('crypto');

/** Stable content hash, used for (a) change detection and (b) deterministic tiebreak. */
function valueHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * Structural value equality.
 *
 * Used by the merge path to decide whether a genuinely concurrent write is a real
 * conflict. Two devices both setting a task to `done` is NOT a conflict and must
 * merge silently; only *different* concurrent values need to surface to the user.
 * Comparing with `===` would be wrong for objects/arrays, and comparing hashes
 * would be needlessly indirect.
 */
function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b) ? true : false;
  return stableStringify(a) === stableStringify(b);
}

/**
 * UUIDv7 (time-ordered) generator.
 *
 * Why time-ordered ids: SQLite primary-key locality (no random B-tree churn) and
 * a free creation-order hint. Why random beyond the timestamp: two devices must not
 * collide, so the remaining 74 bits are cryptographically random, NOT a counter.
 */
function uuidv7() {
  const bytes = crypto.randomBytes(16);
  const ms = BigInt(Date.now());
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

module.exports = { valueHash, stableStringify, uuidv7, sameValue };
