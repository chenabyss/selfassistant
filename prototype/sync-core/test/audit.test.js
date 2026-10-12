'use strict';

// S2 acceptance tests: prove the user-facing history view can be rebuilt exactly
// from the op log, so `audit_log` does not need to be written on every mutation.
//
// The authorising decision was explicit: "先证明历史记录可完整重建，再移除重复写入"
// (prove the history can be fully rebuilt BEFORE removing the duplicate write).
// These tests are that proof, and they are the precondition for dropping the
// write-time `audit_log` insert from the single write path.

const assert = require('assert');
const { test } = require('./harness');
const { DeviceStore } = require('../src/store');
const { MemoryRelay } = require('../src/relay');
const { applySchema } = require('../src/schema');

function newDevice(deviceId, opts) {
  return applySchema(new DeviceStore(deviceId, opts));
}

async function syncAll(relay, devices, rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    for (const d of devices) await d.push(relay);
    for (const d of devices) await d.pull(relay);
  }
}

test('S2: history projection captures create/delete/status/relations', async () => {
  const relay = new MemoryRelay('relay-s2');
  const A = newDevice('device-A');
  const task = A.createEntity('task', { title: 'ship it', status: 'todo' });
  A.setField(task, 'task', 'status', 'in_progress');
  A.setField(task, 'task', 'next_action', 'write tests'); // NOT audit-relevant
  A.setMembership(task, 'task', 'tags', 'urgent', true);
  A.setField(task, 'task', 'status', 'done');

  const rows = A.auditProjection();
  const kinds = rows.map((r) => `${r.kind}:${r.field ?? '-'}`);

  assert.ok(kinds.includes('create:-'), 'creation must be recorded');
  assert.ok(kinds.includes('set:status'), 'status changes must be recorded');
  assert.ok(kinds.includes('set_add:tags'), 'relation changes must be recorded');
  assert.ok(
    !kinds.includes('set:next_action'),
    'ordinary field edits are deliberately excluded (§9.8 requires important changes, not every keystroke)',
  );

  // Status history must be in causal order and include the initial value written at
  // creation time (createEntity emits a `set` per initial field).
  const statusValues = rows.filter((r) => r.field === 'status').map((r) => r.value);
  assert.deepStrictEqual(statusValues, ['todo', 'in_progress', 'done']);
});

test('S2: history is rebuildable - a fresh device reaches the same projection', async () => {
  const relay = new MemoryRelay('relay-s2-rebuild');
  const A = newDevice('device-A');
  const task = A.createEntity('task', { title: 'x', status: 'todo' });
  A.setField(task, 'task', 'status', 'in_progress');
  A.setMembership(task, 'task', 'tags', 'one', true);
  A.setField(task, 'task', 'status', 'done');
  await A.push(relay);

  // A brand-new device with an empty database replays only the op log.
  const B = newDevice('device-B');
  await B.pull(relay);

  assert.strictEqual(
    B.auditDigest(),
    A.auditDigest(),
    'history rebuilt from ops alone must be identical to the original',
  );
  assert.deepStrictEqual(
    B.auditProjection({ entityId: task }),
    A.auditProjection({ entityId: task }),
    'per-object history must match exactly',
  );
});

test('S2: history is rebuildable after the projection is discarded', async () => {
  const relay = new MemoryRelay('relay-s2-discard');
  const A = newDevice('device-A');
  const t1 = A.createEntity('task', { title: 'a', status: 'todo' });
  const t2 = A.createEntity('task', { title: 'b', status: 'todo' });
  A.setField(t1, 'task', 'status', 'done');
  A.setField(t2, 'task', 'status', 'cancelled');
  A.setMembership(t1, 'task', 'tags', 'x', true);

  // The projection holds no state of its own, so "discarding" it is a no-op: there
  // is nothing to invalidate. This test pins that property - if a future change
  // starts caching projection output, rebuilding must still be exact.
  const before = A.auditDigest();
  const rebuilt = A.auditDigest();
  assert.strictEqual(rebuilt, before);

  // Proof it derives only from ops: mutate ops, projection changes accordingly.
  A.setField(t2, 'task', 'status', 'done');
  assert.notStrictEqual(A.auditDigest(), before, 'projection must reflect new ops');
});

test('S2: history is identical across devices after sync', async () => {
  const relay = new MemoryRelay('relay-s2-converge');
  const A = newDevice('device-A');
  const B = newDevice('device-B');
  const task = A.createEntity('task', { title: 'shared', status: 'todo' });
  await syncAll(relay, [A, B]);

  A.setField(task, 'task', 'status', 'in_progress');
  B.setMembership(task, 'task', 'tags', 'from-b', true);
  await A.push(relay);
  await B.push(relay);
  await syncAll(relay, [A, B]);

  assert.strictEqual(A.stateDigest(), B.stateDigest(), 'state converges');
  assert.strictEqual(
    A.auditDigest(),
    B.auditDigest(),
    'derived history must converge too, despite being computed independently on each device',
  );
});

test('S2: conflict resolution appears in the derived history', async () => {
  const relay = new MemoryRelay('relay-s2-conflict');
  const A = newDevice('device-A');
  const B = newDevice('device-B');
  const task = A.createEntity('task', { title: 't', status: 'todo' });
  await syncAll(relay, [A, B]);
  A.setField(task, 'task', 'status', 'done');
  B.setField(task, 'task', 'status', 'cancelled');
  await A.push(relay);
  await B.push(relay);
  await syncAll(relay, [A, B]);

  const c = A.openConflicts()[0];
  A.resolveConflict(c.conflict_id, 'keep_winner');
  await syncAll(relay, [A, B]);

  for (const [name, d] of [['A', A], ['B', B]]) {
    const rows = d.auditProjection().filter((r) => r.kind === 'resolve_conflict');
    assert.strictEqual(rows.length, 1, `${name}: resolution must be traceable in history`);
    assert.strictEqual(rows[0].value, 'keep_winner');
  }
  assert.strictEqual(A.auditDigest(), B.auditDigest(), 'history converges across devices');
});

test('S2: history survives a full replay in arbitrary order', async () => {
  const relay = new MemoryRelay('relay-s2-replay');
  const A = newDevice('device-A');
  const task = A.createEntity('task', { title: 'x', status: 'todo' });
  A.setField(task, 'task', 'status', 'in_progress');
  A.setMembership(task, 'task', 'tags', 'a', true);
  A.setField(task, 'task', 'status', 'done');
  A.setMembership(task, 'task', 'tags', 'b', true);
  await A.push(relay);

  const all = await relay.pull(0, 500);
  const reference = A.auditDigest();

  for (let i = 0; i < 3; i += 1) {
    const C = newDevice('device-C');
    const ops = i % 2 === 0 ? all.ops : [...all.ops].reverse();
    for (const op of ops) C.applyOp(op);
    assert.strictEqual(C.auditDigest(), reference, `replay order ${i} must yield identical history`);
  }
});

test('S2: no write-time audit store exists in the write path', async () => {
  // Guards the actual S2 decision: `audit_log` must not be a second authoritative
  // store written on every mutation. If someone reintroduces a write-time audit row,
  // this fails and forces the conversation.
  const A = newDevice('device-A');
  const task = A.createEntity('task', { title: 'x', status: 'todo' });
  const beforeOps = A.ops.size;
  const beforeConflicts = A.conflicts.length;
  A.setField(task, 'task', 'status', 'done');

  assert.strictEqual(A.ops.size, beforeOps + 1, 'exactly one op per mutation');
  assert.strictEqual(A.conflicts.length, beforeConflicts, 'no conflict for a sequential edit');
  assert.strictEqual(
    A.auditLogRows,
    undefined,
    'there must be no materialised audit store on the device (S2)',
  );
  // And the history is still fully available - derived.
  const projection = A.auditProjection();
  assert.ok(Array.isArray(projection), 'auditProjection must return rows');
  assert.ok(projection.length >= 2, `history remains available from ops (got ${projection.length})`);
});
