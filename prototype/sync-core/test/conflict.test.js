'use strict';

// Tests added in the design-review revision round.
//
// They exist because review found a real contradiction: sync-protocol.md promised
// "concurrent modification must be visible", but scalar (`lww`) fields silently
// picked a winner with the losing value reachable only from the op log. Review also
// asked for coverage of multi-device sync order, repeated delivery, and
// post-resolution convergence.
//
// The contract these tests pin down:
//   * a genuinely concurrent write with a DIFFERENT value => an open, user-visible
//     conflict record, for EVERY strategy (not just `text`)
//   * a causally-later write, or a concurrent write with the SAME value => no
//     conflict (so everyday editing stays quiet)
//   * conflict records are idempotent and identical on every device
//   * resolving a conflict is an ordinary write, so it converges everywhere

const assert = require('assert');
const { test } = require('./harness');
const { DeviceStore } = require('../src/store');
const { MemoryRelay } = require('../src/relay');
const { applySchema } = require('../src/schema');

function newDevice(deviceId, opts) {
  return applySchema(new DeviceStore(deviceId, opts));
}

async function twoDevices() {
  const relay = new MemoryRelay('relay-conflict');
  const A = newDevice('device-A');
  const B = newDevice('device-B');
  return { relay, A, B };
}

/** Full bidirectional sync until both sides are quiescent. */
async function syncAll(relay, devices, rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    for (const d of devices) await d.push(relay);
    for (const d of devices) await d.pull(relay);
  }
}

// ---------------------------------------------------------------------------
// 1. The specific contradiction review raised: scalar fields.
// ---------------------------------------------------------------------------
test('review: concurrent scalar (lww) writes produce a VISIBLE, open conflict', async () => {
  const { relay, A, B } = await twoDevices();
  const id = A.createEntity('task', { title: 't', status: 'todo' });
  await A.push(relay);
  await B.pull(relay);

  // Windows marks done; Android concurrently marks cancelled. Values differ and
  // neither device has seen the other - exactly the reviewer's example.
  A.setField(id, 'task', 'status', 'done');
  B.setField(id, 'task', 'status', 'cancelled');

  await A.push(relay);
  await B.push(relay);
  await syncAll(relay, [A, B]);

  assert.strictEqual(A.getField(id, 'status'), B.getField(id, 'status'), 'must converge');
  assert.strictEqual(A.stateDigest(), B.stateDigest());

  const ca = A.openConflicts();
  const cb = B.openConflicts();
  assert.strictEqual(ca.length, 1, 'device A must show one OPEN conflict');
  assert.strictEqual(cb.length, 1, 'device B must show one OPEN conflict');
  assert.strictEqual(ca[0].strategy, 'lww', 'conflict must be recorded for a scalar field');
  assert.strictEqual(ca[0].field, 'status');
  // The losing value must be inspectable, otherwise "visible" is a lie.
  assert.ok(['done', 'cancelled'].includes(ca[0].losing_value), 'losing value must be retained');
  assert.notStrictEqual(ca[0].losing_value, A.getField(id, 'status'), 'loser differs from winner');
});

test('review: conflicting value is recoverable and both sides agree on the loser', async () => {
  const { relay, A, B } = await twoDevices();
  const id = A.createEntity('task', { title: 't', status: 'todo' });
  await A.push(relay);
  await B.pull(relay);

  A.setField(id, 'task', 'status', 'done');
  B.setField(id, 'task', 'status', 'cancelled');
  await A.push(relay);
  await B.push(relay);
  await syncAll(relay, [A, B]);

  const ca = A.openConflicts()[0];
  const cb = B.openConflicts()[0];
  assert.strictEqual(ca.conflict_id, cb.conflict_id, 'conflict ids must be identical');
  assert.strictEqual(ca.losing_op, cb.losing_op, 'same losing op');
  assert.strictEqual(ca.winning_op, cb.winning_op, 'same winning op');
  assert.strictEqual(ca.losing_value, cb.losing_value, 'same losing value');
});

// ---------------------------------------------------------------------------
// 2. No false positives - the other half of the contract.
// ---------------------------------------------------------------------------
test('review: a causally-later write produces NO conflict', async () => {
  const { relay, A, B } = await twoDevices();
  const id = A.createEntity('task', { title: 't', status: 'todo' });
  await A.push(relay);
  await B.pull(relay);

  A.setField(id, 'task', 'status', 'done');
  await A.push(relay);
  await B.pull(relay); // B has SEEN the change
  B.setField(id, 'task', 'status', 'in_progress');
  await syncAll(relay, [A, B]);

  assert.strictEqual(A.getField(id, 'status'), 'in_progress');
  assert.strictEqual(A.openConflicts().length, 0, 'no conflict when causality is known');
  assert.strictEqual(B.openConflicts().length, 0);
});

test('review: concurrent writes with the SAME value produce NO conflict', async () => {
  const { relay, A, B } = await twoDevices();
  const id = A.createEntity('task', { title: 't', status: 'todo' });
  await A.push(relay);
  await B.pull(relay);

  // Both devices independently complete the same task. Nothing to tell the user.
  A.setField(id, 'task', 'status', 'done');
  B.setField(id, 'task', 'status', 'done');
  await A.push(relay);
  await B.push(relay);
  await syncAll(relay, [A, B]);

  assert.strictEqual(A.getField(id, 'status'), 'done');
  assert.strictEqual(A.openConflicts().length, 0, 'identical concurrent values are not a conflict');
  assert.strictEqual(B.openConflicts().length, 0);
});

test('review: ordinary sequential editing never creates a conflict', async () => {
  const { relay, A, B } = await twoDevices();
  const id = A.createEntity('task', { title: 't', status: 'todo', priority: 'none' });
  await syncAll(relay, [A, B]);

  // 20 alternating edits, each device syncing before the other writes.
  for (let i = 0; i < 20; i += 1) {
    const d = i % 2 === 0 ? A : B;
    d.setField(id, 'task', 'priority', ['none', 'low', 'high', 'urgent'][i % 4]);
    await syncAll(relay, [A, B], 1);
  }
  await syncAll(relay, [A, B]);

  assert.strictEqual(A.openConflicts().length, 0, 'sequential edits must not generate conflicts');
  assert.strictEqual(B.openConflicts().length, 0);
  assert.strictEqual(A.stateDigest(), B.stateDigest());
});

// ---------------------------------------------------------------------------
// 3. Idempotency and ordering (review asked for repeat delivery + order).
// ---------------------------------------------------------------------------
test('review: re-delivering the same ops does not duplicate conflict records', async () => {
  const { relay, A, B } = await twoDevices();
  const id = A.createEntity('task', { title: 't', status: 'todo' });
  await A.push(relay);
  await B.pull(relay);
  A.setField(id, 'task', 'status', 'done');
  B.setField(id, 'task', 'status', 'cancelled');
  await A.push(relay);
  await B.push(relay);
  // Sync first so the conflict exists BEFORE we take the baseline.
  await syncAll(relay, [A, B]);

  const all = await relay.pull(0, 500);
  const beforeTotal = A.conflicts.length;
  const beforeOpen = A.openConflicts().length;
  assert.strictEqual(beforeTotal, 1, 'exactly one conflict after the first sync');

  // Replay every op 5 times through the apply path.
  for (let i = 0; i < 5; i += 1) {
    for (const op of all.ops) A.applyOp(op);
  }
  assert.strictEqual(A.conflicts.length, beforeTotal, 'replay must not add conflict rows');
  assert.strictEqual(A.openConflicts().length, beforeOpen, 'replay must not add open conflicts');
  assert.strictEqual(
    new Set(A.conflicts.map((c) => c.conflict_id)).size,
    A.conflicts.length,
    'conflict ids must stay unique',
  );
});

test('review: conflict set converges regardless of the order devices pull in', async () => {
  const runs = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { relay, A, B } = await twoDevices();
    const id = A.createEntity('task', { title: 't', status: 'todo', priority: 'none' });
    await syncAll(relay, [A, B]);
    A.setField(id, 'task', 'status', 'done');
    A.setField(id, 'task', 'priority', 'high');
    B.setField(id, 'task', 'status', 'cancelled');
    B.setField(id, 'task', 'priority', 'low');
    await A.push(relay);
    await B.push(relay);

    // Vary pull order and batching per attempt.
    const order = attempt % 2 === 0 ? [A, B] : [B, A];
    if (attempt % 3 === 0) {
      const all = await relay.pull(0, 500);
      const shuffled = [...all.ops].reverse();
      for (const d of order) for (const op of shuffled) d.applyOp(op);
    } else {
      for (const d of order) await d.pull(relay);
    }
    await syncAll(relay, [A, B]);

    const sig = (d) =>
      d.conflicts
        .map((c) => `${c.conflict_id}|${c.field}|${c.losing_op}|${c.winning_op}`)
        .sort()
        .join(';');
    runs.push({ a: sig(A), b: sig(B), digestA: A.stateDigest(), digestB: B.stateDigest() });
  }

  for (const [i, r] of runs.entries()) {
    assert.strictEqual(r.a, r.b, `attempt ${i}: both devices must agree on the conflict set`);
    assert.strictEqual(r.digestA, r.digestB, `attempt ${i}: states must converge`);
  }
  // All attempts should describe the same conflicts (same fields, same count).
  const shapes = new Set(runs.map((r) => r.a.split(';').map((s) => s.split('|')[1]).sort().join(',')));
  assert.strictEqual(shapes.size, 1, `conflict shape must be stable across orders: ${[...shapes].join(' / ')}`);
});

// ---------------------------------------------------------------------------
// 4. Resolution must itself converge (review: "resolution syncs as a new op").
// ---------------------------------------------------------------------------
test('review: choosing the losing value resolves and converges on all devices', async () => {
  const { relay, A, B } = await twoDevices();
  const id = A.createEntity('task', { title: 't', status: 'todo' });
  await syncAll(relay, [A, B]);
  A.setField(id, 'task', 'status', 'done');
  B.setField(id, 'task', 'status', 'cancelled');
  await A.push(relay);
  await B.push(relay);
  await syncAll(relay, [A, B]);

  const conflict = A.openConflicts()[0];
  assert.ok(conflict, 'expected an open conflict');
  const loserValue = conflict.losing_value;
  const winnerValue = A.getField(id, 'status');
  assert.notStrictEqual(loserValue, winnerValue);

  // A resolves by keeping the value that lost.
  const res = A.resolveConflict(conflict.conflict_id, 'keep_loser');
  assert.ok(res.op_id, 'resolution must emit a new op');
  assert.strictEqual(A.getField(id, 'status'), loserValue, 'field now holds the chosen value');

  await syncAll(relay, [A, B]);

  assert.strictEqual(B.getField(id, 'status'), loserValue, 'resolution must reach B');
  assert.strictEqual(A.getField(id, 'status'), B.getField(id, 'status'));
  assert.strictEqual(A.stateDigest(), B.stateDigest(), 'resolution must converge');
  assert.strictEqual(A.openConflicts().length, 0, 'conflict closed on A');
  // It is acceptable for B to have re-derived the record and closed it too.
  assert.strictEqual(B.openConflicts().length, 0, 'conflict closed on B');
});

test('review: resolving the same conflict twice is rejected as already resolved', async () => {
  const { relay, A, B } = await twoDevices();
  const id = A.createEntity('task', { title: 't', status: 'todo' });
  await syncAll(relay, [A, B]);
  A.setField(id, 'task', 'status', 'done');
  B.setField(id, 'task', 'status', 'cancelled');
  await A.push(relay);
  await B.push(relay);
  await syncAll(relay, [A, B]);

  const c = A.openConflicts()[0];
  A.resolveConflict(c.conflict_id, 'keep_loser');
  const second = A.resolveConflict(c.conflict_id, 'keep_winner');
  assert.strictEqual(second.alreadyResolved, true, 'second resolution must be a no-op');
});

test('review: resolving emits an explicit resolution op recorded in the op log', async () => {
  const { relay, A, B } = await twoDevices();
  const id = A.createEntity('task', { title: 't', status: 'todo' });
  await syncAll(relay, [A, B]);
  A.setField(id, 'task', 'status', 'done');
  B.setField(id, 'task', 'status', 'cancelled');
  await A.push(relay);
  await B.push(relay);
  await syncAll(relay, [A, B]);

  const c = A.openConflicts()[0];
  const opsBefore = A.ops.size;
  const res = A.resolveConflict(c.conflict_id, 'keep_loser');

  // S1: a resolution is an explicit, replicated op - not a locally derived flag.
  assert.ok(A.ops.has(res.op_id), 'resolution op must be in the op log');
  const op = A.ops.get(res.op_id);
  assert.strictEqual(op.op_type, 'resolve_conflict');
  assert.strictEqual(op.field, c.conflict_id, 'op carries the conflict id');
  assert.strictEqual(op.value, 'keep_loser', 'op carries the choice');
  // keep_loser writes a value, so exactly two ops are emitted.
  assert.strictEqual(A.ops.size, opsBefore + 2, 'value op + resolution op');
  assert.ok(res.value_op_id, 'keep_loser must also write the value');
});

test('review: keep_winner emits ONLY a resolution op (no value write)', async () => {
  const { relay, A, B } = await twoDevices();
  const id = A.createEntity('task', { title: 't', status: 'todo' });
  await syncAll(relay, [A, B]);
  A.setField(id, 'task', 'status', 'done');
  B.setField(id, 'task', 'status', 'cancelled');
  await A.push(relay);
  await B.push(relay);
  await syncAll(relay, [A, B]);

  const c = A.openConflicts()[0];
  const winner = A.getField(id, 'status');
  const opsBefore = A.ops.size;
  const res = A.resolveConflict(c.conflict_id, 'keep_winner');

  assert.strictEqual(A.getField(id, 'status'), winner, 'value unchanged');
  assert.strictEqual(res.value_op_id, null, 'no value write for keep_winner');
  assert.strictEqual(A.ops.size, opsBefore + 1, 'exactly one op: the resolution');
  assert.strictEqual(A.ops.get(res.op_id).op_type, 'resolve_conflict');
});

test('review: keep_winner resolution propagates and closes the conflict everywhere', async () => {
  const { relay, A, B } = await twoDevices();
  const id = A.createEntity('task', { title: 't', status: 'todo' });
  await syncAll(relay, [A, B]);
  A.setField(id, 'task', 'status', 'done');
  B.setField(id, 'task', 'status', 'cancelled');
  await A.push(relay);
  await B.push(relay);
  await syncAll(relay, [A, B]);

  const c = A.openConflicts()[0];
  assert.strictEqual(B.openConflicts().length, 1, 'B also sees the conflict as pending');

  A.resolveConflict(c.conflict_id, 'keep_winner');
  assert.strictEqual(A.openConflicts().length, 0, 'A closes immediately');

  await syncAll(relay, [A, B]);

  // This is the case that failed before S1: the value never changed, so B had no
  // signal. The explicit resolution op is what fixes it.
  assert.strictEqual(B.openConflicts().length, 0, 'B must learn the conflict was resolved');
  const bc = B.conflictsWithState().find((x) => x.conflict_id === c.conflict_id);
  assert.ok(bc, 'B still has the conflict record');
  assert.strictEqual(bc.resolution, 'keep_winner', 'B sees the recorded choice');
  assert.strictEqual(bc.resolution_device, 'device-A', 'B sees who resolved it');
  assert.strictEqual(A.getField(id, 'status'), B.getField(id, 'status'), 'values agree');
  assert.strictEqual(A.stateDigest(), B.stateDigest(), 'states converge');
});

test('review: resolution op is idempotent under repeated delivery and reordering', async () => {
  const { relay, A, B } = await twoDevices();
  const id = A.createEntity('task', { title: 't', status: 'todo' });
  await syncAll(relay, [A, B]);
  A.setField(id, 'task', 'status', 'done');
  B.setField(id, 'task', 'status', 'cancelled');
  await A.push(relay);
  await B.push(relay);
  await syncAll(relay, [A, B]);

  const c = A.openConflicts()[0];
  const res = A.resolveConflict(c.conflict_id, 'keep_loser');
  await A.push(relay);

  const all = await relay.pull(0, 500);

  // First, let B catch up normally so it has applied the resolution once.
  await B.pull(relay);
  const sig = (d) =>
    d
      .conflictsWithState()
      .filter((x) => x.resolution_op)
      .map((x) => `${x.conflict_id}:${x.resolution_op}:${x.resolution}`)
      .sort()
      .join('|');
  const before = sig(B);
  assert.strictEqual(B.conflictsWithState().filter((x) => x.resolution_op).length, 1);

  // Now replay the whole history several times, in reverse order. Applying an op
  // that is already applied is a no-op, so nothing may change.
  for (let i = 0; i < 3; i += 1) {
    for (const op of [...all.ops].reverse()) B.applyOp(op);
  }
  await syncAll(relay, [A, B]);

  assert.strictEqual(sig(B), before, 'repeated reordering must not duplicate or lose resolution state');
  const bc = B.conflictsWithState().find((x) => x.conflict_id === c.conflict_id);
  assert.strictEqual(bc.resolution_op, res.op_id, 'same resolution op id on both devices');
  assert.strictEqual(A.getField(id, 'status'), B.getField(id, 'status'), 'values agree');
  assert.strictEqual(A.stateDigest(), B.stateDigest());
});

// ---------------------------------------------------------------------------
// 5. The latent bug fixed alongside the visibility fix.
// ---------------------------------------------------------------------------
test('review: a discarded losing write still merges its version vector', async () => {
  const { relay, A, B } = await twoDevices();
  const id = A.createEntity('task', { title: 't', status: 'todo' });
  await syncAll(relay, [A, B]);
  A.setField(id, 'task', 'status', 'done');
  B.setField(id, 'task', 'status', 'cancelled');
  await A.push(relay);
  await B.push(relay);
  await syncAll(relay, [A, B]);

  // Both devices must have folded the other side into the field register, so
  // neither re-evaluates the loser forever, and a third write cannot lose it.
  const regA = A.entities.get(id).fields.get('status');
  const regB = B.entities.get(id).fields.get('status');
  assert.ok(regA.vv['device-A'] >= 1, 'A register knows about A');
  assert.ok(regA.vv['device-B'] >= 1, 'A register must fold in the losing device-B write');
  assert.ok(regB.vv['device-A'] >= 1, 'B register must fold in device-A');

  // A third device's later write must be able to supersede cleanly.
  const C = newDevice('device-C');
  await C.pull(relay);
  C.setField(id, 'task', 'status', 'in_progress');
  await C.push(relay);
  await syncAll(relay, [A, B, C]);
  assert.strictEqual(A.getField(id, 'status'), 'in_progress');
  assert.strictEqual(B.getField(id, 'status'), 'in_progress');
  assert.strictEqual(A.stateDigest(), C.stateDigest(), 'three devices converge');
});

// ---------------------------------------------------------------------------
// 6. Sets and text keep working, and now also surface conflicts.
// ---------------------------------------------------------------------------
test('review: concurrent set-membership removal vs add still converges to union rules', async () => {
  const { relay, A, B } = await twoDevices();
  const id = A.createEntity('log_entry', { title: 'e' });
  A.setMembership(id, 'log_entry', 'tags', 'alpha', true);
  await syncAll(relay, [A, B]);
  assert.deepStrictEqual(B.getSet(id, 'tags'), ['alpha']);

  A.setMembership(id, 'log_entry', 'tags', 'alpha', false); // A removes
  B.setMembership(id, 'log_entry', 'tags', 'beta', true); // B adds a different tag
  await syncAll(relay, [A, B]);

  assert.deepStrictEqual(A.getSet(id, 'tags'), ['beta'], 'removal of alpha sticks, beta added');
  assert.deepStrictEqual(B.getSet(id, 'tags'), ['beta']);
  assert.strictEqual(A.stateDigest(), B.stateDigest());
});

test('review: text conflicts remain visible and resolvable end to end', async () => {
  const { relay, A, B } = await twoDevices();
  const id = A.createEntity('journal_entry', { body: 'v0' });
  await syncAll(relay, [A, B]);
  A.setField(id, 'journal_entry', 'body', 'windows version');
  B.setField(id, 'journal_entry', 'body', 'android version');
  await A.push(relay);
  await B.push(relay);
  await syncAll(relay, [A, B]);

  const c = A.openConflicts()[0];
  assert.ok(c, 'text conflict must be open');
  assert.strictEqual(c.both_versions_retained, true, 'text keeps both versions');
  const loser = c.losing_value;
  A.resolveConflict(c.conflict_id, 'keep_loser');
  await syncAll(relay, [A, B]);
  assert.strictEqual(A.getField(id, 'body'), loser);
  assert.strictEqual(B.getField(id, 'body'), loser, 'text resolution must converge');
  assert.strictEqual(A.stateDigest(), B.stateDigest());
});
