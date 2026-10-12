'use strict';

const { HlcClock, encodeHlc, compareHlc } = require('./hlc');
const { vvBump, vvMerge, vvCompare } = require('./vvec');
const { STRATEGY, decideLww, applyLww, snapshot } = require('./merge');
const { valueHash, uuidv7, sameValue } = require('./hash');

/**
 * In-memory model of ONE device's local database + change log.
 *
 * Tables it stands in for (see data-model.md):
 *   entities(id, type, created_at, updated_at, deleted_at, rev)
 *   field_registers(entity_id, field, strategy, value_json, vv_json, hlc, op_id)
 *   set_elements(entity_id, field, element, present, hlc, op_id)
 *   ops(op_id PK, device_id, entity_id, entity_type, op_type, field, value_json,
 *       vv_json, hlc, conflict_of, local_seq)          <- the append-only log
 *   op_outbox(op_id PK, sent_seq)                      <- unsent local changes
 *   sync_cursors(peer_id, applied_seq)                 <- how far we pulled per peer
 *   devices(device_id, name, last_seen_hlc)
 *
 * The class is deliberately close to the real schema so that the Dart port is a
 * translation rather than a redesign.
 */
class DeviceStore {
  constructor(deviceId, opts = {}) {
    this.deviceId = deviceId;
    this.clock = new HlcClock(deviceId, opts.now);
    /** @type {Map<string, {id:string,type:string,created_at:number,updated_at:number,deleted:boolean,fields:Map,setFields:Map,textFields:Map,opIds:Set<string>}>} */
    this.entities = new Map();
    /** oplog: op_id -> op */
    this.ops = new Map();
    /** op_ids created locally that have not been acked by the relay */
    this.outbox = new Set();
    /** applied server revision per relay */
    this.cursors = new Map();
    /** ops applied per relay cursor, to prove no gaps/duplicates */
    this.appliedFromCursor = new Map();
    this.skewWarnings = [];
    this.nextLocalSeq = 1;
    /**
     * Conflict records, derived from op pairs plus explicit `resolve_conflict` ops.
     * Initialised eagerly (not lazily) so callers can always read `.length` and
     * iterate without a null check - a lazily created array made "no conflicts yet"
     * indistinguishable from a programming error.
     */
    this.conflicts = [];
    /**
     * Field-schema registry: entityType -> field -> strategy.
     *
     * This is the lesson from the first prototype run. Two distinct hazards showed up:
     *
     *  1. If the strategy is not durable, an op replayed from the log (or re-pulled
     *     after a crash) carries no strategy, defaults to LWW, and silently downgrades
     *     a text conflict into a lost write.
     *  2. If the strategy is inferred from the *first writer*, then any code path that
     *     touches a field before the schema is declared (e.g. the initial values passed
     *     to createEntity) permanently pins that field to the wrong merge rule.
     *
     * Therefore: the schema is DECLARED per entity type before any data is written, is
     * stored in the database (field_schema table), and is synced like any other
     * metadata so every device merges a given field the same way.
     */
    this.schema = new Map();
    /** ack bookkeeping for exactly-once push assertions */
    this.pushedAcks = new Set();
  }

  // ---------------------------------------------------------------- local writes

  _ensure(entityId, type, atMs) {
    let e = this.entities.get(entityId);
    if (!e) {
      e = {
        id: entityId,
        type,
        created_at: atMs,
        updated_at: atMs,
        deleted: false,
        fields: new Map(),
        setFields: new Map(),
        opIds: new Set(),
      };
      this.entities.set(entityId, e);
    }
    return e;
  }

  _makeOp(entityId, entityType, opType, field, value, vv, hlc, conflictOf = null, strategy = STRATEGY.LWW) {
    return {
      op_id: uuidv7(),
      device_id: this.deviceId,
      entity_id: entityId,
      entity_type: entityType,
      op_type: opType,
      field,
      value,
      vv,
      hlc,
      conflict_of: conflictOf,
      strategy,
      local_seq: this.nextLocalSeq++,
    };
  }

  /** Declare the merge rule for a field of an entity type. Must precede any write. */
  declareField(entityType, field, strategy) {
    if (!this.schema.has(entityType)) this.schema.set(entityType, new Map());
    const fields = this.schema.get(entityType);
    const existing = fields.get(field);
    if (existing && existing !== strategy) {
      throw new Error(`field strategy conflict for ${entityType}.${field}: ${existing} vs ${strategy}`);
    }
    fields.set(field, strategy);
    return strategy;
  }

  registerFieldStrategy(entityType, field, strategy) {
    return this.declareField(entityType, field, strategy);
  }

  fieldStrategy(entityType, field, fallback = STRATEGY.LWW) {
    const fields = this.schema.get(entityType);
    return (fields && fields.get(field)) || fallback;
  }

  /**
   * Create a new entity. Creation itself is an op, so it replicates like any other.
   * `initial` values are written through the declared field schema - a field that has
   * not been declared is skipped rather than silently pinned to the LWW default.
   */
  createEntity(type, initial = {}) {
    const id = uuidv7();
    const hlc = this.clock.tick();
    const op = this._makeOp(id, type, 'create', null, { initial }, {}, hlc);
    this._appendLocal(op);
    this.applyOp(op);
    for (const [field, value] of Object.entries(initial)) {
      const declared = (this.schema.get(type) || new Map()).has(field);
      if (!declared) {
        throw new Error(
          `createEntity(${type}) writes undeclared field "${field}": declare its merge strategy first`,
        );
      }
      this.setField(id, type, field, value, this.fieldStrategy(type, field));
    }
    return id;
  }

  /**
   * Local scalar/text write. Bumps the per-field version vector for this device.
   *
   * The merge strategy is resolved from the declared schema. `strategy` is only a
   * fallback for entity types whose schema has not been declared yet (used by
   * low-level tests); it must never silently override a declared field rule.
   */
  setField(entityId, entityType, field, value, strategy) {
    const declared = (this.schema.get(entityType) || new Map()).has(field);
    const effective = declared
      ? this.fieldStrategy(entityType, field)
      : this.declareField(entityType, field, strategy || STRATEGY.LWW);
    const e = this._ensure(entityId, entityType, Date.now());
    const local = e.fields.get(field);
    if (local && local.value === value && effective !== STRATEGY.TEXT) return null;
    const vv = vvBump(local ? local.vv : {}, this.deviceId);
    const hlc = this.clock.tick();
    const op = this._makeOp(entityId, entityType, 'set', field, value, vv, hlc, null, effective);
    this._appendLocal(op);
    this.applyOp(op);
    return op.op_id;
  }

  /** Local set-membership change (tags, relations). */
  setMembership(entityId, entityType, field, element, present) {
    this._ensure(entityId, entityType, Date.now());
    const key = `${entityId}\u0000${field}\u0000${element}`;
    const existing = this.setRegisters && this.setRegisters.get(key);
    const vv = vvBump(existing ? existing.vv : {}, this.deviceId);
    const hlc = this.clock.tick();
    const op = this._makeOp(entityId, entityType, present ? 'set_add' : 'set_remove', field, element, vv, hlc);
    this._appendLocal(op);
    this.applyOp(op);
    return op.op_id;
  }

  _appendLocal(op) {
    this.ops.set(op.op_id, op);
    this.outbox.add(op.op_id);
  }

  // --------------------------------------------------------------------- apply

  /**
   * Apply an op (local or remote) to materialised state. Idempotent: applying the
   * same op_id twice is a no-op. Returns a small report used by tests/telemetry.
   */
  applyOp(op) {
    // Observe the remote clock HERE, not only in `pull`.
    //
    // Ordering depends on the local HLC having already absorbed every remote stamp
    // we have seen. Previously that side effect lived in `pull`, so any other caller
    // (retry logic, a manual replay, a test) could apply an op without advancing the
    // clock first, and the incoming write would then be mis-ordered against local
    // state - producing spurious conflicts and, in the worst case, letting an older
    // value win. Making it part of `applyOp` removes the ordering hazard by
    // construction; `observeRemoteClock` is idempotent for local ops.
    this.observeRemoteClock(op);

    if (this.ops.has(op.op_id) && !this.outbox.has(op.op_id)) {
      const prior = this.ops.get(op.op_id);
      if (prior.applied) return { applied: false, reason: 'already-applied' };
    }
    const existingOp = this.ops.get(op.op_id);
    if (existingOp && existingOp.applied) return { applied: false, reason: 'already-applied' };

    const record = { ...op, applied: false };
    this.ops.set(op.op_id, record);

    const report = this._applyToState(record);
    record.applied = true;
    return report;
  }

  _applyToState(op) {
    const at = op.hlc ? op.hlc.p : Date.now();
    const e = this._ensure(op.entity_id, op.entity_type, at);
    if (op.op_type === 'create') {
      e.created_at = Math.min(e.created_at, at);
      return { applied: true, reason: 'create' };
    }
    if (op.op_type === 'delete') {
      e.deleted = true;
      e.deleted_hlc = op.hlc;
      e.updated_at = at;
      return { applied: true, reason: 'tombstone' };
    }
    if (op.op_type === 'set_add' || op.op_type === 'set_remove') {
      return this._applySetOp(op, e);
    }
    if (op.op_type === 'resolve_conflict') {
      // A resolution op carries no field value of its own; it settles a conflict by
      // id. Applying it just refreshes the derived resolution state, which is what
      // makes `keep_winner` visible on every device.
      for (const c of this.conflicts || []) {
        if (c.conflict_id === op.field) this._updateResolutionState(c);
      }
      return { applied: true, reason: 'conflict-resolved' };
    }
    return this._applyFieldOp(op, e);
  }

  /**
   * Apply a field write, recording a user-visible conflict whenever a genuinely
   * concurrent write carried a DIFFERENT value.
   *
   * Two things were wrong before this fix (both found in design review):
   *
   *  1. Only the `text` strategy produced user-visible conflicts. `lww` fields
   *     (task status, dates, single-valued relations) silently picked a winner and
   *     left the loser in the op log where nothing ever surfaced it. That directly
   *     contradicted "concurrent modification must be visible".
   *
   *  2. A discarded losing write never merged its version vector into
   *     `field_register`. Consequences: (a) the loser's op was re-evaluated and
   *     re-discarded on every subsequent sync, and (b) worse, once a *third*
   *     device's write arrived, the discarded value was unrecoverable even in
   *     principle, because the register no longer knew the loser had been observed.
   *     Merging the vector is therefore mandatory for correctness, not bookkeeping.
   */
  _applyFieldOp(op, e, { recordConflict = true } = {}) {
    const local = e.fields.get(op.field);
    const strategy = this.fieldStrategy(op.entity_type, op.field, op.strategy || STRATEGY.LWW);
    if (!(this.schema.get(op.entity_type) || new Map()).has(op.field) && op.strategy) {
      this.declareField(op.entity_type, op.field, op.strategy);
    }

    const decision = decideLww(local, op, strategy, recordConflict);

    if (decision.action === 'apply') {
      const cc = decision.concurrent;
      // Concurrent writes with DIFFERENT values produce a visible conflict.
      // Identical values (both devices set `done`) merge silently - otherwise
      // everyday editing would drown the user in noise.
      if (cc && !sameValue(cc.loser.value, cc.winner.value)) {
        this._recordConflict(op.entity_id, op.field, strategy, cc.loser, cc.winner);
      }
      const next = applyLww(local, op);
      next.strategy = strategy;
      e.fields.set(op.field, next);
      e.updated_at = Math.max(e.updated_at, op.hlc ? op.hlc.p : 0);
      // No resolution bookkeeping here: settling a conflict requires an explicit
      // `resolve_conflict` op (S1). Deriving it from ordinary writes is what made
      // `keep_winner` fail to propagate and what made conflicts close themselves
      // the instant they were detected.
      return { applied: true, reason: decision.reason };
    }

    if (decision.action === 'conflict') {
      const cc = decision.concurrent;
      if (cc && !sameValue(cc.loser.value, cc.winner.value)) {
        this._recordConflict(op.entity_id, op.field, strategy, cc.loser, cc.winner);
      }
      // Merge the loser's vector so causality is recorded even though the value
      // lost. Without this the loser's op is re-evaluated forever and, once a third
      // device writes, the discarded value becomes unrecoverable.
      const merged = { ...local, vv: vvMerge(local.vv, op.vv || {}) };
      e.fields.set(op.field, merged);
      return { applied: false, reason: decision.reason, conflictKept: true };
    }

    return { applied: false, reason: decision.reason };
  }

  /**
   * Persist a conflict record.
   *
   * `conflict_id` is a deterministic hash of (losing op, winning op, field). Two
   * devices observe the same conflict from opposite directions, so a deterministic
   * id is what makes the record idempotent AND makes the conflict list itself
   * converge. Hashing both op ids (rather than keying on one) means a conflict and
   * its mirror image cannot produce two different rows.
   */
  _recordConflict(entityId, field, strategy, losingSide, winnerSide) {
    if (!this.conflicts) this.conflicts = [];
    const losingOpId = losingSide.opId;
    const winningOpId = winnerSide && winnerSide.opId;
    if (!losingOpId || !winningOpId) {
      throw new Error(
        `conflict for ${entityId}.${field} missing op id ` +
          `(loser keys: ${Object.keys(losingSide).join(',')}; winner keys: ${winnerSide ? Object.keys(winnerSide).join(',') : 'none'})`,
      );
    }
    // Deterministic id over BOTH op ids: the same conflict is observed from
    // opposite directions on two devices, so hashing both sides is what makes the
    // record idempotent AND makes the conflict list itself converge.
    const conflictId = valueHash(`conflict|${losingOpId}|${winningOpId}|${field}`);
    const existing = this.conflicts.find((c) => c.conflict_id === conflictId);
    if (existing) return existing;
    const record = {
      conflict_id: conflictId,
      entity_id: entityId,
      field,
      strategy,
      losing_value: losingSide.value,
      losing_op: losingOpId,
      losing_hlc: losingSide.hlc,
      losing_vv: losingSide.vv,
      winning_op: winningOpId,
      winning_value: winnerSide ? winnerSide.value : undefined,
      winning_vv: winnerSide ? winnerSide.vv : undefined,
      detected_at: Date.now(),
      // Resolution is DERIVED from the op log (see `_resolutionFor`), never stored as
      // device-local truth. Keeping it local is exactly what made `keep_winner` fail
      // to propagate: that choice does not change the field value, so other devices
      // had no signal to react to.
      resolved_at: null,
      resolution: null,
      resolution_op: null,
      resolution_device: null,
      // `text` keeps both bodies; scalar fields keep the losing value for inspection
      // and possible restore, with only one value being "current".
      both_versions_retained: strategy === STRATEGY.TEXT,
    };
    this.conflicts.push(record);
    this._updateResolutionState(record);
    return record;
  }

  /**
   * Derive a conflict's resolution from the op log.
   *
   * A resolution is an `op_type='resolve_conflict'` op, whose `field` column carries
   * the `conflict_id` and whose `value` carries the choice. Because it is an ordinary
   * replicated op with a globally unique `op_id`, every device observes the SAME
   * resolution - so `keep_winner` now closes the conflict everywhere, not just on the
   * device where the user clicked.
   *
   * Design note: resolution state is authoritative (it is a user decision), but it is
   * authoritative *as an op*, not as a locally computed flag. Per-device derivation of
   * "is this settled" was the original approach and it silently diverged.
   */
  _resolutionFor(conflictId) {
    for (const op of this.ops.values()) {
      if (op.op_type === 'resolve_conflict' && op.field === conflictId) return op;
    }
    return null;
  }

  /** Refresh the cached resolution fields on a conflict record from the op log. */
  _updateResolutionState(c) {
    const op = this._resolutionFor(c.conflict_id);
    if (!op) return c;
    c.resolution = op.value; // keep_winner | keep_loser | custom
    c.resolution_op = op.op_id;
    c.resolution_device = op.device_id;
    c.resolved_at = op.hlc ? op.hlc.p : null;
    return c;
  }

  /**
   * User resolves a conflict by choosing a side.
   *
   * Emits up to two ops:
   *  1. a value write - only when the chosen value actually differs from the current
   *     one (`keep_winner` deliberately writes nothing);
   *  2. an explicit `resolve_conflict` op - always.
   *
   * Op (2) is the whole point of S1: without it, `keep_winner` leaves every other
   * device showing the conflict as pending forever, because the field value never
   * changed and there was nothing for them to observe.
   */
  resolveConflict(conflictId, choice, customValue) {
    const c = (this.conflicts || []).find((x) => x.conflict_id === conflictId);
    if (!c) throw new Error(`unknown conflict: ${conflictId}`);
    if (this._resolutionFor(conflictId)) return { alreadyResolved: true, conflict: c };

    const entity = this.entities.get(c.entity_id);
    if (!entity) throw new Error(`conflict references missing entity: ${c.entity_id}`);
    const strategy = this.fieldStrategy(entity.type, c.field, STRATEGY.LWW);

    let value;
    if (choice === 'keep_loser') value = c.losing_value;
    else if (choice === 'keep_winner') value = entity.fields.get(c.field)?.value;
    else if (choice === 'custom') value = customValue;
    else throw new Error(`unknown resolution choice: ${choice}`);

    let valueOpId = null;
    if (choice !== 'keep_winner') {
      valueOpId = this.setField(c.entity_id, entity.type, c.field, value, strategy);
    }

    const current = this.entities.get(c.entity_id).fields.get(c.field);
    const resolveOp = this._makeOp(
      c.entity_id,
      entity.type,
      'resolve_conflict',
      conflictId,
      choice,
      vvBump(current ? current.vv : {}, this.deviceId),
      this.clock.tick(),
      null,
      STRATEGY.LWW,
    );
    resolveOp.value_op_id = valueOpId;
    this._appendLocal(resolveOp);
    this.applyOp(resolveOp);

    return { conflict: c, op_id: resolveOp.op_id, value_op_id: valueOpId };
  }

  /**
   * Unresolved conflicts, newest first. UI counter and conflict page read this.
   * "Unresolved" now means: no `resolve_conflict` op exists for this conflict id.
   */
  openConflicts() {
    return this.conflictsWithState().filter((c) => !c.resolution_op);
  }

  /** All conflicts, with resolution state refreshed from the op log. */
  conflictsWithState() {
    return (this.conflicts || [])
      .map((c) => this._updateResolutionState(c))
      .sort((a, b) => b.detected_at - a.detected_at);
  }

  /**
   * Derive the user-facing history view ("audit log") from the op log on demand.
   *
   * This is S2: `audit_log` is NOT a second authoritative store and must not be
   * written on every mutation. It is a projection of `op`, which is already the
   * single source of truth. Keeping it write-time would double the write volume for
   * data that can be recomputed exactly.
   *
   * The projection must be *complete enough* to answer "what happened to this
   * object": creation, deletion, restores, and the field changes that
   * `decisions/0005` classifies as important. Ordinary edits to other fields are
   * intentionally excluded - spec §9.8 requires important state changes to be
   * traceable, not every keystroke.
   */
  static AUDIT_RELEVANT_FIELDS = new Set([
    'status',
    'previous_status',
    'process_action',
    'notification_state',
    'completed_at',
    'conversion_refs',
  ]);

  auditProjection({ entityId = null, limit = null } = {}) {
    const relevantFields = DeviceStore.AUDIT_RELEVANT_FIELDS;
    const rows = [];
    for (const op of this.ops.values()) {
      const relevant =
        op.op_type === 'create' ||
        op.op_type === 'delete' ||
        op.op_type === 'restore' ||
        op.op_type === 'resolve_conflict' ||
        (op.op_type === 'set' && relevantFields.has(op.field)) ||
        op.op_type === 'set_add' ||
        op.op_type === 'set_remove';
      if (!relevant) continue;
      if (entityId && op.entity_id !== entityId) continue;
      rows.push({
        op_id: op.op_id,
        at: op.hlc ? op.hlc.p : null,
        hlc: op.hlc,
        device_id: op.device_id,
        entity_id: op.entity_id,
        entity_type: op.entity_type,
        kind: op.op_type,
        field: op.field,
        value: op.value,
      });
    }
    // Order by the FULL HLC, not just physical time. Two ops in the same millisecond
    // would otherwise be ordered arbitrarily (by op id), producing a history that
    // reads out of causal order - e.g. showing "in_progress -> done" before the
    // initial "todo". A history view that can reorder events is worse than useless.
    rows.sort((a, b) => {
      const c = compareHlc(a.hlc || encodeHlc(0, 0, ''), b.hlc || encodeHlc(0, 0, ''));
      if (c !== 0) return c;
      return a.op_id < b.op_id ? -1 : a.op_id > b.op_id ? 1 : 0;
    });
    return limit ? rows.slice(-limit) : rows;
  }

  /** Deterministic digest of the derived history, for "rebuild equivalence" tests. */
  auditDigest(opts) {
    return valueHash(this.auditProjection(opts));
  }

  /** Unresolved conflicts, newest first. UI counter and conflict page read this. */
  openConflicts() {
    return (this.conflicts || [])
      .filter((c) => !c.resolved_at)
      .sort((a, b) => b.detected_at - a.detected_at);
  }

  _applySetOp(op, e) {
    if (!this.setRegisters) this.setRegisters = new Map();
    const key = `${op.entity_id}\u0000${op.field}\u0000${op.value}`;
    const local = this.setRegisters.get(key);
    const wantPresent = op.op_type === 'set_add';
    const vv = local ? local.vv : {};
    const rel = vvCompare(op.vv || {}, vv);

    // Set semantics: per-element, the later write wins. Ties broken by total order.
    if (local) {
      if (rel === 'dominated') return { applied: false, reason: 'set:stale' };
      if (rel === 'equal') {
        const { orderOps } = require('./merge');
        if (orderOps(op, local) <= 0) return { applied: false, reason: 'set:lost-total-order' };
      }
      if (local.present === wantPresent && rel !== 'concurrent') {
        return { applied: false, reason: 'set:no-change' };
      }
      if (rel === 'concurrent') {
        const { orderOps } = require('./merge');
        if (orderOps(op, local) <= 0) return { applied: false, reason: 'set:concurrent-lost' };
      }
    }

    this.setRegisters.set(key, {
      entity_id: op.entity_id,
      field: op.field,
      element: op.value,
      present: wantPresent,
      vv: vvMerge(vv, op.vv || {}),
      hlc: op.hlc,
      opId: op.op_id,
    });
    e.updated_at = Math.max(e.updated_at, op.hlc ? op.hlc.p : 0);
    return { applied: true, reason: wantPresent ? 'set:add' : 'set:remove' };
  }

  // ------------------------------------------------------------------- reading

  getField(entityId, field) {
    const e = this.entities.get(entityId);
    if (!e) return undefined;
    const reg = e.fields.get(field);
    return reg ? reg.value : undefined;
  }

  getSet(entityId, field) {
    const out = [];
    for (const reg of (this.setRegisters || new Map()).values()) {
      if (reg.entity_id === entityId && reg.field === field && reg.present) out.push(reg.element);
    }
    return out.sort();
  }

  /** Deterministic digest of the whole visible state - used to assert convergence. */
  stateDigest() {
    const rows = [];
    for (const e of [...this.entities.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const fields = [...e.fields.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([k, v]) => `${k}=${valueHash(v.value)}`);
      const sets = [];
      for (const reg of (this.setRegisters || new Map()).values()) {
        if (reg.entity_id === e.id && reg.present) sets.push(`${reg.field}:${reg.element}`);
      }
      rows.push(`${e.id}|${e.deleted ? 'D' : 'A'}|${fields.join(',')}|${sets.sort().join(',')}`);
    }
    return valueHash(rows.join('\n'));
  }

  /** Pending local changes, oldest first. */
  pendingOps() {
    return [...this.outbox].map((id) => this.ops.get(id)).filter(Boolean).sort((a, b) => a.local_seq - b.local_seq);
  }

  /** Serialise unsent changes for one push (bounded batch, like the real client). */
  _pushBatch(limit) {
    const batch = this.pendingOps().slice(0, limit);
    return batch;
  }

  // --------------------------------------------------------------- sync client

  /** PUSH: hand local changes to a relay. Idempotent on the relay side. */
  async push(relay, { limit = 100, simulatePartial = false } = {}) {
    const batch = this._pushBatch(limit);
    if (batch.length === 0) return { pushed: 0, acked: 0 };
    const payload = batch.map((o) => ({
      op_id: o.op_id,
      device_id: o.device_id,
      entity_id: o.entity_id,
      entity_type: o.entity_type,
      op_type: o.op_type,
      field: o.field,
      value: o.value,
      vv: o.vv,
      hlc: o.hlc,
      conflict_of: o.conflict_of,
      strategy: o.strategy,
      // Carried for `resolve_conflict` ops so peers can link the resolution back to
      // the value write it produced (if any).
      value_op_id: o.value_op_id ?? null,
    }));
    const res = await relay.push(payload, { simulatePartial });
    for (const ack of res.acked) {
      this.outbox.delete(ack.op_id);
      this.pushedAcks.add(ack.op_id);
    }
    return { pushed: payload.length, acked: res.acked.length, rejected: res.rejected };
  }

  /**
   * PULL: read changes from a relay cursor and apply them.
   * Cursor is advanced ONLY after every op in the batch applies, so a crash mid-batch
   * re-pulls and re-applies harmlessly (idempotent apply).
   */
  async pull(relay, { limit = 200 } = {}) {
    const cursorKey = relay.id;
    let since = this.cursors.get(cursorKey) || 0;
    let total = 0;
    for (;;) {
      const page = await relay.pull(since, limit);
      if (page.ops.length === 0) break;
      for (const op of page.ops) {
        // Clock observation happens inside applyOp (see there for why).
        this.applyOp(op);
        total += 1;
      }
      const seen = this.appliedFromCursor.get(cursorKey) || [];
      seen.push(...page.ops.map((o) => o.seq));
      this.appliedFromCursor.set(cursorKey, seen);
      since = page.next_cursor;
      this.cursors.set(cursorKey, since);
      if (!page.has_more) break;
    }
    return { applied: total, cursor: since };
  }

  observeRemoteClock(op) {
    if (!op.hlc || op.device_id === this.deviceId) return;
    const res = this.clock.observe(op.hlc);
    if (res.suspectedSkew) {
      this.skewWarnings.push({ device_id: op.device_id, skewMs: res.skewMs, op_id: op.op_id });
    }
  }

  async sync(relay, opts = {}) {
    const pushed = await this.push(relay, opts);
    const pulled = await this.pull(relay, opts);
    return { pushed, pulled };
  }
}

module.exports = { DeviceStore, STRATEGY, encodeHlc, compareHlc };
