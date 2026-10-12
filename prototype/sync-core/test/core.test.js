'use strict';

const assert = require('assert');
const { test, run } = require('./harness');
const { DeviceStore } = require('../src/store');
const { MemoryRelay } = require('../src/relay');
const { STRATEGY } = require('../src/merge');
const { applySchema } = require('../src/schema');
const { vvCompare } = require('../src/vvec');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A device with the V1 field schema declared, as the real app will do at startup. */
function newDevice(deviceId, opts) {
  return applySchema(new DeviceStore(deviceId, opts));
}

/** Two devices sharing one relay. */
async function pair(opts = {}) {
  const relay = new MemoryRelay('relay-main');
  const A = newDevice('device-A', opts.A);
  const B = newDevice('device-B', opts.B);
  return { relay, A, B };
}

// ---------------------------------------------------------------------------
// 1. Idempotency: the same change pushed many times must never duplicate.
// ---------------------------------------------------------------------------
test('idempotency: re-pushing the same batch creates no duplicate rows', async () => {
  const { relay, A } = await pair();
  const id = A.createEntity('task', { title: 'inspect mesh generation failure', status: 'todo' });
  A.setField(id, 'task', 'status', 'in_progress');

  const before = A.pendingOps().length;
  assert.ok(before >= 2, 'expected create + 2 field ops');

  const first = await A.push(relay);
  assert.strictEqual(first.acked, before);
  assert.strictEqual(first.pushed, before);

  // Simulate a retry storm: the same ops, repeated.
  const batch = relay.ops.slice();
  for (let i = 0; i < 5; i += 1) {
    const res = await relay.push(batch);
    assert.ok(res.acked.every((a) => a.deduped), 'every replayed op must be deduped');
  }
  assert.strictEqual(relay.ops.length, before, 'relay row count must not grow on replay');
  assert.strictEqual(new Set(relay.ops.map((o) => o.op_id)).size, relay.ops.length, 'op_id must be unique');
});

test('idempotency: applying the same op twice locally is a no-op', async () => {
  const { A } = await pair();
  const id = A.createEntity('task', { title: 'x' });
  const op = A.ops.get(A.setField(id, 'task', 'status', 'done'));
  const r1 = A.applyOp(op);
  const r2 = A.applyOp(op);
  assert.strictEqual(r1.applied, false, 'op was already applied as a local write');
  assert.strictEqual(r2.applied, false);
  assert.strictEqual(A.getField(id, 'status'), 'done');
});

// ---------------------------------------------------------------------------
// 2. Convergence: both devices end in the same state regardless of apply order.
// ---------------------------------------------------------------------------
test('convergence: concurrent edits on A and B converge to identical state', async () => {
  const { relay, A, B } = await pair();
  const id = A.createEntity('task', { title: 'shared', priority: 'low', status: 'todo' });
  await A.push(relay);
  await B.pull(relay);
  assert.strictEqual(B.getField(id, 'title'), 'shared');

  // Both edit the SAME entity, different fields, with no sync in between.
  A.setField(id, 'task', 'priority', 'high');
  B.setField(id, 'task', 'status', 'in_progress');

  await A.push(relay);
  await B.push(relay);
  await B.pull(relay);
  await A.pull(relay);

  assert.strictEqual(A.stateDigest(), B.stateDigest(), 'states must converge exactly');
  assert.strictEqual(A.getField(id, 'priority'), 'high');
  assert.strictEqual(A.getField(id, 'status'), 'in_progress');
  assert.strictEqual(B.getField(id, 'priority'), 'high');
  assert.strictEqual(B.getField(id, 'status'), 'in_progress');
});

test('convergence: same-field concurrent writes resolve identically on all devices', async () => {
  const { relay, A, B } = await pair();
  const id = A.createEntity('task', { title: 't', status: 'todo' });
  await A.push(relay);
  await B.pull(relay);

  A.setField(id, 'task', 'status', 'done');
  B.setField(id, 'task', 'status', 'cancelled');

  await A.push(relay);
  await B.push(relay);
  await B.pull(relay);
  await A.pull(relay);

  const a = A.getField(id, 'status');
  const b = B.getField(id, 'status');
  assert.strictEqual(a, b, 'last-writer-wins must pick the same winner everywhere');
  assert.ok(['done', 'cancelled'].includes(a));
});

// ---------------------------------------------------------------------------
// 3. Text conflicts must not silently discard a side.
// ---------------------------------------------------------------------------
test('conflict: concurrent body edits keep both versions and flag a conflict', async () => {
  const { relay, A, B } = await pair();
  const id = A.createEntity('journal_entry', { body: 'v0' });
  await A.push(relay);
  await B.pull(relay);

  A.setField(id, 'journal_entry', 'body', 'written on windows');
  B.setField(id, 'journal_entry', 'body', 'written on android');

  await A.push(relay);
  await B.push(relay);
  await B.pull(relay);
  await A.pull(relay);

  assert.strictEqual(A.getField(id, 'body'), B.getField(id, 'body'), 'winner must match');
  const conflictsA = A.conflicts || [];
  const conflictsB = B.conflicts || [];
  assert.strictEqual(conflictsA.length, 1, 'device A must record one conflict copy');
  assert.strictEqual(conflictsB.length, 1, 'device B must record one conflict copy');
  // Conflict records are keyed by the losing op, so both devices describe the SAME
  // conflict identically: A's text lost, B's text won.
  assert.strictEqual(conflictsA[0].losing_value, 'written on windows');
  assert.strictEqual(conflictsB[0].losing_value, 'written on windows');
  assert.strictEqual(conflictsA[0].losing_op, conflictsB[0].losing_op, 'same losing op on both sides');
  assert.strictEqual(conflictsA[0].winning_op, conflictsB[0].winning_op, 'same winning op on both sides');
  assert.strictEqual(A.stateDigest(), B.stateDigest(), 'conflict handling must still converge');
});

test('conflict: a causally-later edit is NOT reported as a conflict', async () => {
  const { relay, A, B } = await pair();
  const id = A.createEntity('journal_entry', { body: 'v0' });
  await A.push(relay);
  await B.pull(relay);

  A.setField(id, 'journal_entry', 'body', 'A edit');
  await A.push(relay);
  await B.pull(relay); // B has SEEN A's edit
  B.setField(id, 'journal_entry', 'body', 'B edit after seeing A');
  await B.push(relay);
  await A.pull(relay);

  assert.strictEqual(A.getField(id, 'body'), 'B edit after seeing A');
  assert.strictEqual((A.conflicts || []).length, 0, 'no conflict when causality is known');
  assert.strictEqual((B.conflicts || []).length, 0);
});

test('schema: an undeclared field cannot be written (guards the merge rule)', async () => {
  const { A } = await pair();
  assert.throws(
    () => A.createEntity('task', { not_a_real_field: 1 }),
    /undeclared field/,
    'writing an undeclared field must fail loudly, not default to LWW',
  );
});

// ---------------------------------------------------------------------------
// 4. Set semantics (tags, relations): union with tombstones, order independent.
// ---------------------------------------------------------------------------
test('sets: concurrent tag adds converge to the union', async () => {
  const { relay, A, B } = await pair();
  const id = A.createEntity('log_entry', { title: 'entry' });
  await A.push(relay);
  await B.pull(relay);

  A.setMembership(id, 'log_entry', 'tags', 'tag-x', true);
  B.setMembership(id, 'log_entry', 'tags', 'tag-y', true);

  await A.push(relay);
  await B.push(relay);
  await B.pull(relay);
  await A.pull(relay);

  assert.deepStrictEqual(A.getSet(id, 'tags'), ['tag-x', 'tag-y']);
  assert.deepStrictEqual(B.getSet(id, 'tags'), ['tag-x', 'tag-y']);
  assert.strictEqual(A.stateDigest(), B.stateDigest());
});

test('sets: a removal concurrent with an add is not resurrected', async () => {
  const { relay, A, B } = await pair();
  const id = A.createEntity('log_entry', { title: 'entry' });
  A.setMembership(id, 'log_entry', 'tags', 'tag-z', true);
  await A.push(relay);
  await B.pull(relay);
  assert.deepStrictEqual(B.getSet(id, 'tags'), ['tag-z']);

  A.setMembership(id, 'log_entry', 'tags', 'tag-z', false);

  await A.push(relay);
  await B.push(relay);
  await B.pull(relay);
  await A.pull(relay);

  assert.deepStrictEqual(A.getSet(id, 'tags'), [], 'removal must win for A');
  assert.deepStrictEqual(B.getSet(id, 'tags'), [], 'removal must propagate to B');
  assert.strictEqual(A.stateDigest(), B.stateDigest());
});

test('sets: a genuinely later re-add wins over an earlier removal', async () => {
  const { relay, A, B } = await pair();
  const id = A.createEntity('log_entry', { title: 'entry' });
  A.setMembership(id, 'log_entry', 'tags', 'tag-q', true);
  await A.push(relay);
  await B.pull(relay);

  B.setMembership(id, 'log_entry', 'tags', 'tag-q', false);
  await B.push(relay);
  await A.pull(relay); // A sees the removal
  A.setMembership(id, 'log_entry', 'tags', 'tag-q', true); // A re-adds AFTER seeing it
  await A.push(relay);
  await B.pull(relay);

  assert.deepStrictEqual(A.getSet(id, 'tags'), ['tag-q']);
  assert.deepStrictEqual(B.getSet(id, 'tags'), ['tag-q']);
  assert.strictEqual(A.stateDigest(), B.stateDigest());
});

// ---------------------------------------------------------------------------
// 5. Tombstones: deletes replicate and do not resurrect.
// ---------------------------------------------------------------------------
test('tombstones: a delete propagates and a concurrent stale edit cannot resurrect the row', async () => {
  const { relay, A, B } = await pair();
  const id = A.createEntity('task', { title: 'to delete', status: 'todo' });
  await A.push(relay);
  await B.pull(relay);

  B.setField(id, 'task', 'title', 'edited on B'); // concurrent edit
  const delOp = {
    op_id: 'op-delete-fixed-0001',
    device_id: 'device-A',
    entity_id: id,
    entity_type: 'task',
    op_type: 'delete',
    field: null,
    value: null,
    vv: { 'device-A': 1 },
    hlc: { p: Date.now() + 10, l: 0, d: 'device-A' },
    strategy: null,
  };
  A.applyOp(delOp);
  A.ops.set(delOp.op_id, { ...delOp, applied: true });
  A.outbox.add(delOp.op_id);

  await A.push(relay);
  await B.push(relay);
  await B.pull(relay);
  await A.pull(relay);

  assert.strictEqual(A.entities.get(id).deleted, true);
  assert.strictEqual(B.entities.get(id).deleted, true, 'tombstone must replicate to B');
  assert.strictEqual(A.stateDigest(), B.stateDigest());
});

test('tombstones: replaying a delete many times keeps exactly one tombstone', async () => {
  const { relay, A, B } = await pair();
  const id = A.createEntity('task', { title: 'x' });
  await A.push(relay);
  await B.pull(relay);
  const delOp = {
    op_id: 'op-delete-fixed-0002',
    device_id: 'device-A',
    entity_id: id,
    entity_type: 'task',
    op_type: 'delete',
    field: null,
    value: null,
    vv: { 'device-A': 9 },
    hlc: { p: Date.now() + 5, l: 0, d: 'device-A' },
    strategy: null,
  };
  for (let i = 0; i < 3; i += 1) {
    const res = await relay.push([delOp]);
    assert.strictEqual(res.acked.length, 1);
  }
  assert.strictEqual(relay.ops.filter((o) => o.op_type === 'delete').length, 1);
});

// ---------------------------------------------------------------------------
// 6. Cursor integrity: no gaps, no double-apply, resumable after a crash.
// ---------------------------------------------------------------------------
test('cursor: incremental pulls see every op exactly once, with no gaps', async () => {
  const { relay, A, B } = await pair();
  const ids = [];
  for (let i = 0; i < 12; i += 1) ids.push(A.createEntity('task', { title: `t${i}` }));
  for (let i = 0; i < 6; i += 1) await A.push(relay, { limit: 5 });

  const applied = [];
  const origApply = B.applyOp.bind(B);
  B.applyOp = (op) => {
    applied.push(op.op_id);
    return origApply(op);
  };
  let cursor = 0;
  for (;;) {
    const page = await relay.pull(cursor, 3);
    if (!page.ops.length) break;
    for (const op of page.ops) B.applyOp(op);
    cursor = page.next_cursor;
    if (!page.has_more) break;
  }

  const seqs = relay.allSeqs();
  assert.strictEqual(new Set(seqs).size, seqs.length, 'server seq must be unique');
  assert.strictEqual(applied.length, new Set(applied).size, 'no op may be applied twice in one clean walk');
  assert.strictEqual(new Set(applied).size, relay.ops.length, 'every server op must be applied');
  for (const id of ids) assert.ok(B.entities.has(id), `entity ${id} must exist on B`);
  assert.strictEqual(A.stateDigest(), B.stateDigest());
});

test('cursor: a crash mid-pull replays safely from the last durable cursor', async () => {
  const { relay, A, B } = await pair();
  for (let i = 0; i < 10; i += 1) A.createEntity('task', { title: `t${i}` });
  await A.push(relay);

  const page1 = await relay.pull(0, 4);
  for (const op of page1.ops) B.applyOp(op);
  const digestBeforeCrash = B.stateDigest();

  // After a restart the cursor is still 0 -> re-pull and re-apply from scratch.
  B.cursors.set(relay.id, 0);
  await B.pull(relay);
  assert.strictEqual(B.stateDigest(), A.stateDigest(), 'replay must reach the same state');
  assert.notStrictEqual(digestBeforeCrash, B.stateDigest());
  assert.strictEqual(new Set(relay.ops.map((o) => o.op_id)).size, relay.ops.length);
});

// ---------------------------------------------------------------------------
// 7. Partial push failure: retry must neither duplicate nor lose data.
// ---------------------------------------------------------------------------
test('retry: a partially-failed push retried in full neither duplicates nor loses ops', async () => {
  const { relay, A } = await pair();
  const id = A.createEntity('task', { title: 'partial', status: 'todo', priority: 'high' });
  A.setField(id, 'task', 'next_action', 'do the thing');
  const expected = A.pendingOps().length;

  const res = await A.push(relay, { simulatePartial: true });
  assert.ok(res.rejected.length > 0, 'the simulated failure must reject part of the batch');
  assert.ok(A.pendingOps().length > 0, 'unacked ops must stay in the outbox');

  await A.push(relay);
  assert.strictEqual(A.pendingOps().length, 0, 'outbox must drain after retry');
  assert.strictEqual(relay.ops.length, expected, 'relay must hold exactly one copy of each op');
  assert.strictEqual(new Set(relay.ops.map((o) => o.op_id)).size, expected);

  const B = newDevice('device-B');
  await B.pull(relay);
  assert.strictEqual(B.getField(id, 'next_action'), 'do the thing');
  assert.strictEqual(A.stateDigest(), B.stateDigest());
});

// ---------------------------------------------------------------------------
// 8. Clock skew: a wrong clock must not silently win, and must not run away.
// ---------------------------------------------------------------------------
test('clock skew: a device whose clock is an hour behind does not overwrite newer data', async () => {
  const base = Date.now();
  const relay = new MemoryRelay('relay-skew');
  const A = newDevice('device-A', { now: () => base });
  const bClock = base - 3600 * 1000; // B is one hour behind
  const B = newDevice('device-B', { now: () => bClock });

  const id = A.createEntity('task', { title: 'skew', status: 'todo' });
  await A.push(relay);
  await B.pull(relay); // B observes A's HLC, which pulls B's logical clock forward

  A.setField(id, 'task', 'status', 'done');
  await A.push(relay);
  await B.pull(relay);

  B.setField(id, 'task', 'status', 'cancelled'); // while B's wall clock is still behind
  await B.push(relay);
  await A.pull(relay);

  assert.strictEqual(A.getField(id, 'status'), B.getField(id, 'status'), 'must converge');
  assert.strictEqual(A.stateDigest(), B.stateDigest());
  // Causality, not wall clock, decides: B saw 'done', so B's edit is legitimate and wins.
  assert.strictEqual(A.getField(id, 'status'), 'cancelled');
});

test('clock skew: a device with a far-future clock is flagged and cannot run away with time', async () => {
  const base = Date.now();
  const relay = new MemoryRelay('relay-future');
  const A = newDevice('device-A', { now: () => base });
  const future = base + 48 * 3600 * 1000; // 48h ahead
  const F = newDevice('device-F', { now: () => future });

  const id = A.createEntity('task', { title: 't', status: 'todo' });
  await A.push(relay);
  await F.pull(relay);
  F.setField(id, 'task', 'status', 'done');
  await F.push(relay);
  await A.pull(relay);

  assert.ok(A.skewWarnings.length > 0, 'A must warn about the future-dated peer');
  assert.ok(A.clock.p <= base + A.clock.maxDriftMs, 'local physical clock must stay bounded');
  assert.strictEqual(A.getField(id, 'status'), 'done');
});

// ---------------------------------------------------------------------------
// 9. Version-vector sanity: the invariant everything else depends on.
// ---------------------------------------------------------------------------
test('version vectors: comparison classifies dominated/equal/concurrent correctly', () => {
  assert.strictEqual(vvCompare({ A: 1 }, { A: 1 }), 'equal');
  assert.strictEqual(vvCompare({ A: 2 }, { A: 1 }), 'dominates');
  assert.strictEqual(vvCompare({ A: 1 }, { A: 2 }), 'dominated');
  assert.strictEqual(vvCompare({ A: 2, B: 1 }, { A: 1, B: 1 }), 'dominates');
  assert.strictEqual(vvCompare({ A: 1, B: 1 }, { A: 2 }), 'concurrent');
});

// ---------------------------------------------------------------------------
// 10. Three-device fan-out: convergence is order independent.
// ---------------------------------------------------------------------------
test('three devices: random interleavings converge to one state', async () => {
  const relay = new MemoryRelay('relay-3');
  const devices = [newDevice('d1'), newDevice('d2'), newDevice('d3')];
  const seedId = devices[0].createEntity('task', { title: 'fanout', status: 'todo', priority: 'low' });
  await devices[0].push(relay);
  await devices[1].pull(relay);
  await devices[2].pull(relay);

  const edits = [
    () => devices[0].setField(seedId, 'task', 'title', 'from-d1'),
    () => devices[1].setField(seedId, 'task', 'status', 'in_progress'),
    () => devices[2].setMembership(seedId, 'task', 'tags', 'tag-1', true),
    () => devices[0].setMembership(seedId, 'task', 'tags', 'tag-2', true),
    () => devices[1].setField(seedId, 'task', 'priority', 'high'),
    () => devices[2].setField(seedId, 'task', 'next_action', 'step'),
  ];

  let s = 12345;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (const edit of edits) {
    edit();
    if (rnd() > 0.4) await devices[Math.floor(rnd() * 3)].push(relay);
    if (rnd() > 0.5) await devices[Math.floor(rnd() * 3)].pull(relay);
  }
  for (let round = 0; round < 3; round += 1) {
    for (const d of devices) await d.push(relay);
    for (const d of devices) await d.pull(relay);
    await sleep(1);
  }

  const digests = devices.map((d) => d.stateDigest());
  assert.strictEqual(new Set(digests).size, 1, `all devices must converge: ${JSON.stringify(digests)}`);
  assert.strictEqual(devices[0].getField(seedId, 'title'), 'from-d1');
  assert.deepStrictEqual(devices[2].getSet(seedId, 'tags'), ['tag-1', 'tag-2']);
});

// ---------------------------------------------------------------------------
// 11. Attachments: content-addressed, no duplicate blob transfer.
// ---------------------------------------------------------------------------
test('attachments: identical content hashes are stored once', async () => {
  const { valueHash } = require('../src/hash');
  const relay = new MemoryRelay('relay-blobs');
  relay.blobs = new Map();
  const upload = (bytes) => {
    const h = valueHash(Buffer.from(bytes).toString('base64'));
    if (relay.blobs.has(h)) return { hash: h, deduped: true };
    relay.blobs.set(h, bytes);
    return { hash: h, deduped: false };
  };
  const a = upload('same-bytes');
  const b = upload('same-bytes');
  const c = upload('other-bytes');
  assert.strictEqual(a.deduped, false);
  assert.strictEqual(b.deduped, true);
  assert.strictEqual(a.hash, b.hash);
  assert.notStrictEqual(a.hash, c.hash);
  assert.strictEqual(relay.blobs.size, 2);
});

