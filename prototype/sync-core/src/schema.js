'use strict';

const { STRATEGY } = require('./merge');

/**
 * V1 field-level merge schema.
 *
 * Every persisted field must appear here, because the choice of merge rule is a
 * PRODUCT decision, not an implementation detail:
 *
 *   lww   - the newest write wins. Correct for scalars where "both" is meaningless
 *           (a status, a date, a duration, an amount). The losing value is still
 *           kept in the op log, so it is auditable, but the user is not interrupted.
 *   text  - same as lww for the *current* value, but a concurrent divergent edit
 *           additionally produces a conflict copy the user can inspect and merge.
 *           Used only where silently dropping a paragraph would be unacceptable.
 *   set   - add/remove with per-element ordering. Correct for tags and relations,
 *           where two devices independently attaching different tags must both win.
 *
 * `additive` is deliberately absent: summing counters across devices is unsafe
 * (a repeated delivery double-counts). Totals are always derived, never stored.
 */
const SCHEMA = {
  inbox_item: {
    content: STRATEGY.TEXT,
    status: STRATEGY.LWW,
    deferred_until: STRATEGY.LWW,
    source_type: STRATEGY.LWW,
    conversion_refs: STRATEGY.SET,
  },
  task: {
    title: STRATEGY.TEXT,
    description: STRATEGY.TEXT,
    status: STRATEGY.LWW,
    project_id: STRATEGY.LWW,
    parent_task_id: STRATEGY.LWW,
    scheduled_date: STRATEGY.LWW,
    due_at: STRATEGY.LWW,
    next_action: STRATEGY.TEXT,
    priority: STRATEGY.LWW,
    completed_at: STRATEGY.LWW,
  },
  reminder: {
    content: STRATEGY.TEXT,
    status: STRATEGY.LWW,
    remind_at: STRATEGY.LWW,
    due_at: STRATEGY.LWW,
    related_task_id: STRATEGY.LWW,
    completed_at: STRATEGY.LWW,
  },
  project: {
    name: STRATEGY.TEXT,
    description: STRATEGY.TEXT,
    status: STRATEGY.LWW,
    start_date: STRATEGY.LWW,
    target_date: STRATEGY.LWW,
  },
  time_entry: {
    start_at: STRATEGY.LWW,
    end_at: STRATEGY.LWW,
    category: STRATEGY.LWW,
    description: STRATEGY.TEXT,
    task_id: STRATEGY.LWW,
    project_id: STRATEGY.LWW,
    source: STRATEGY.LWW,
    timer_state: STRATEGY.LWW,
  },
  log_entry: {
    title: STRATEGY.TEXT,
    body: STRATEGY.TEXT,
    occurred_at: STRATEGY.LWW,
    project_id: STRATEGY.LWW,
    source_inbox_id: STRATEGY.LWW,
  },
  journal_entry: {
    journal_date: STRATEGY.LWW,
    body: STRATEGY.TEXT,
    mood: STRATEGY.LWW,
  },
  conclusion: {
    title: STRATEGY.TEXT,
    body: STRATEGY.TEXT,
    scope: STRATEGY.LWW,
  },
  tag: {
    name: STRATEGY.LWW,
    color: STRATEGY.LWW,
  },
  attachment: {
    kind: STRATEGY.LWW,
    sha256: STRATEGY.LWW,
    display_name: STRATEGY.LWW,
  },
};

/** Fields whose values are sets of ids (tag membership, relations). */
const SET_FIELDS = {
  task: ['tags'],
  log_entry: ['tags', 'related_task_ids', 'related_project_ids'],
  journal_entry: ['tags', 'refs'],
  project: ['tags'],
  reminder: ['tags'],
  conclusion: ['tags', 'source_refs'],
  attachment: ['refs'],
  inbox_item: ['tags', 'attachment_refs'],
};

/**
 * Relations that are modelled as set membership rather than a foreign-key column,
 * because both sides may be edited concurrently. Task -> Project stays a scalar FK
 * (a task has exactly one project), while e.g. LogEntry -> Task is a set.
 */
function applySchema(store) {
  for (const [entityType, fields] of Object.entries(SCHEMA)) {
    for (const [field, strategy] of Object.entries(fields)) {
      store.declareField(entityType, field, strategy);
    }
  }
  for (const [entityType, fields] of Object.entries(SET_FIELDS)) {
    for (const field of fields) {
      store.declareField(entityType, field, STRATEGY.SET);
    }
  }
  return store;
}

module.exports = { SCHEMA, SET_FIELDS, applySchema };
