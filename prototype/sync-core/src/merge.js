'use strict';

const { vvCompare, vvMerge } = require('./vvec');
const { compareHlc, encodeHlc } = require('./hlc');
const { valueHash } = require('./hash');

/**
 * Field merge strategies.
 *
 * The spec demands an explicit conflict strategy per field class, so the model
 * makes the strategy part of the schema, not an afterthought:
 *
 *   lww       scalar (title, status, dates, amounts, time intervals)
 *             -> per-field version vector; concurrent writes resolved by a total
 *                order (HLC, then deviceId, then opId). Deterministic, no silent loss
 *                of the *record*, but the losing value is retained in the audit log
 *                and surfaced as a "superseded value" the user can inspect.
 *
 *   set       tag membership, many-to-many relation membership
 *             -> add/remove with per-element HLC. Union of live elements.
 *                Removal is a tombstone with its own HLC: an element removed after
 *                it was added stays removed; a re-add after removal wins.
 *
 *   text      free text bodies (journal body, log body, task description)
 *             -> lww for the "current" value PLUS an explicit conflict copy when two
 *                devices edit concurrently (neither version was seen by the other).
 *                This is the only way to satisfy "must not silently discard one side".
 */

const STRATEGY = { LWW: 'lww', SET: 'set', TEXT: 'text' };

/**
 * Total order for two competing writes to the same field. Deterministic on all
 * devices. Accepts either an op (snake_case `op_id`) or a field register
 * (camelCase `opId`), because both shapes compete here — reading only `op_id` was a
 * latent bug: register-vs-op comparisons silently fell through to `undefined`,
 * which made the "final tiebreak" a no-op and produced conflicts whose losing op
 * id was lost.
 */
function opIdOf(x) {
  return x.op_id !== undefined ? x.op_id : x.opId;
}

function orderOps(a, b) {
  const hlcA = a.hlc || encodeHlc(0, 0, a.device_id || a.deviceId || '');
  const hlcB = b.hlc || encodeHlc(0, 0, b.device_id || b.deviceId || '');
  const c = compareHlc(hlcA, hlcB);
  if (c !== 0) return c;
  const ha = valueHash(a.value);
  const hb = valueHash(b.value);
  if (ha < hb) return -1;
  if (ha > hb) return 1;
  const ia = opIdOf(a);
  const ib = opIdOf(b);
  if (ia === ib) return 0;
  if (ia === undefined) return -1;
  if (ib === undefined) return 1;
  return ia < ib ? -1 : 1;
}

/**
 * Decide what to do with one incoming field op against local field state.
 *
 * @param {object} local  { value, vv, hlc, opId } or undefined
 * @param {object} op     incoming op: { op_id, device_id, value, vv, hlc, conflict_of }
 * @param {string} strategy
 * @param {boolean} recordConflict when true, a genuinely concurrent write with a
 *   DIFFERENT value yields a conflictVersion so the caller can persist a conflict
 *   record. This applies to ALL strategies, not just `text`:
 *
 *   The review found the original design self-contradictory. `sync-protocol.md`
 *   promised "concurrent modification must be visible", but the `lww` path simply
 *   picked a winner by total order and left the loser only in the op log, which no
 *   device ever surfaces. For a personal life log "task marked done on Windows,
 *   cancelled on Android" is exactly the case where silently picking one loses
 *   information the user cares about.
 *
 *   Note the important qualifier: only *genuinely concurrent* writes with
 *   *different* values conflict. Two devices both setting `done` is not a conflict,
 *   and a causally-later write is never a conflict. This keeps everyday editing
 *   from generating noise.
 *
 * @returns {{action:'apply'|'noop'|'conflict', reason:string, conflictVersion?:object}}
 */
function decideLww(local, op, strategy, recordConflict = false) {
  if (!local) {
    return { action: 'apply', reason: 'field-absent' };
  }
  if (local.opId === op.op_id) {
    return { action: 'noop', reason: 'duplicate-op-id' };
  }
  const rel = vvCompare(op.vv || {}, local.vv || {});
  if (rel === 'dominated') {
    // Incoming write is older than what we have: drop it, but a previously
    // recorded conflict for this op stays valid (see store.applyOp).
    return { action: 'noop', reason: `stale:${rel}` };
  }
  if (rel === 'equal') {
    // Same vector but a different op id: the total order still gives a
    // deterministic winner. Values differ only if the two devices wrote different
    // things with identical vectors, which is itself a real conflict.
    const c = orderOps(op, local);
    const localSide = snapshot(local);
    const opSide = snapshot(op);
    if (c > 0) {
      return {
        action: 'apply',
        reason: 'equal-vector-total-order',
        concurrent: recordConflict ? { winner: opSide, loser: localSide } : undefined,
      };
    }
    return {
      action: recordConflict ? 'conflict' : 'noop',
      reason: 'equal-vector-total-order:lost',
      concurrent: recordConflict ? { winner: localSide, loser: opSide } : undefined,
    };
  }
  if (rel === 'dominates') {
    // A causally-later write is a NORMAL edit, not a conflict. No conflictVersion:
    // emitting one here would make every ordinary save look like a conflict.
    return { action: 'apply', reason: 'causally-newer' };
  }

  // --- concurrent ---------------------------------------------------------
  const c = orderOps(op, local);
  const winnerIsOp = c > 0;

  if (!recordConflict) {
    // Conflict recording disabled (used where the entity-level path handles
    // visibility). Keep the deterministic behaviour only.
    return winnerIsOp
      ? { action: 'apply', reason: 'concurrent:won-total-order' }
      : { action: 'noop', reason: 'concurrent:lost-total-order' };
  }

  // Report BOTH sides explicitly. The previous version returned a `conflictVersion`
  // snapshot and required the caller to know whether it described the incoming op
  // or the local register — that ambiguity is what let a `undefined` op id reach the
  // conflict record. Naming both sides makes the contract impossible to misread.
  const localSide = snapshot(local);
  const opSide = snapshot(op);
  return winnerIsOp
    ? {
        action: 'apply',
        reason: 'concurrent:won-total-order',
        concurrent: { winner: opSide, loser: localSide },
      }
    : {
        action: 'conflict',
        reason: 'concurrent:lost-total-order',
        concurrent: { winner: localSide, loser: opSide },
      };
}

/**
 * Serialisable snapshot of either an op or a field register.
 *
 * Both shapes flow through the merge path: ops use snake_case (`op_id`), field
 * registers use camelCase (`opId`). Reading only `opId` (the original code) meant
 * every snapshot of an *incoming op* silently carried `opId: undefined`, and since
 * JSON drops undefined values the resulting conflict record lost its `losing_op`
 * entirely - making the conflict un-resolvable and un-convergent.
 */
function snapshot(x) {
  if (!x) return undefined;
  return {
    value: x.value,
    vv: x.vv,
    hlc: x.hlc,
    opId: opIdOf(x),
  };
}

/** Apply an accepted field write to the materialised state. */
function applyLww(local, op) {
  return {
    value: op.value,
    vv: vvMerge(local ? local.vv : {}, op.vv || {}),
    hlc: op.hlc,
    opId: op.op_id,
  };
}

module.exports = { STRATEGY, decideLww, applyLww, orderOps, snapshot };
