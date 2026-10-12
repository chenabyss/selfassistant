'use strict';

/**
 * Reference SYNC RELAY (in-memory, for protocol validation only).
 *
 * Deliberately dumb, because the hard part belongs on the clients:
 *   - it assigns a single monotonic revision (`seq`) to every accepted change
 *   - it deduplicates by op_id, so a retried push can never duplicate a row
 *   - it stores ops immutably; it never merges, never resolves conflicts
 *   - pull is cursor-based (`since`), so a client that crashes mid-sync simply
 *     re-pulls from its last durable cursor
 *
 * This shape also maps cleanly onto a real backend: (ops table with UNIQUE(op_id),
 * BIGINT identity seq, GET /changes?since=&limit=) or onto
 * a "sync folder" adapter that appends to a file.
 */
class MemoryRelay {
  constructor(id = 'relay-1') {
    this.id = id;
    this.ops = [];
    this.byOpId = new Map();
    this.seq = 0;
    this.stats = { push_calls: 0, ops_received: 0, ops_accepted: 0, ops_deduped: 0, pull_calls: 0 };
  }

  /**
   * @param {Array<object>} ops
   * @returns {Promise<{acked:Array<{op_id:string,seq:number}>, rejected:Array<{op_id:string,reason:string}>}>}
   */
  async push(ops, { simulatePartial = false } = {}) {
    this.stats.push_calls += 1;
    this.stats.ops_received += ops.length;
    const acked = [];
    const rejected = [];

    // simulatePartial models a network/DB failure partway through the batch: the
    // server persisted some ops and then errored. The client must retry the whole
    // batch; dedupe makes that safe.
    const cutoff = simulatePartial ? Math.floor(ops.length / 2) : ops.length;

    for (let i = 0; i < ops.length; i += 1) {
      const op = ops[i];
      if (!op.op_id) {
        rejected.push({ op_id: null, reason: 'missing-op-id' });
        continue;
      }
      const existing = this.byOpId.get(op.op_id);
      if (existing) {
        this.stats.ops_deduped += 1;
        acked.push({ op_id: op.op_id, seq: existing.seq, deduped: true });
        continue;
      }
      if (i >= cutoff) {
        rejected.push({ op_id: op.op_id, reason: 'transient-write-failure' });
        continue;
      }
      this.seq += 1;
      const stored = { ...op, seq: this.seq, received_at: Date.now() };
      this.ops.push(stored);
      this.byOpId.set(op.op_id, stored);
      acked.push({ op_id: op.op_id, seq: this.seq, deduped: false });
      this.stats.ops_accepted += 1;
    }

    // A real server would return 5xx here when some ops were rejected.
    return { acked, rejected, partial: simulatePartial && rejected.length > 0 };
  }

  /** @returns {Promise<{ops:Array, next_cursor:number, has_more:boolean}>} */
  async pull(since = 0, limit = 200) {
    this.stats.pull_calls += 1;
    const ops = this.ops.filter((o) => o.seq > since).slice(0, limit);
    const next = ops.length ? ops[ops.length - 1].seq : since;
    return { ops, next_cursor: next, has_more: since + ops.length < this.seq };
  }

  /** Every seq ever assigned, to prove a cursor walk has no gaps and no repeats. */
  allSeqs() {
    return this.ops.map((o) => o.seq);
  }
}

module.exports = { MemoryRelay };
