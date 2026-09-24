-- M5 waits: one row per ctx.wait call. The row is the durable record; consumed_at marks the outcome as final.
CREATE TABLE waits (
  run_id       uuid        NOT NULL,
  name         text        NOT NULL,
  event_name   text,
  wake_at      timestamptz NOT NULL,
  resolved_at  timestamptz,
  payload      jsonb,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, name)
);

-- sendEvent: find open waits for an event
CREATE INDEX waits_open_by_event ON waits (event_name) WHERE resolved_at IS NULL AND consumed_at IS NULL;

-- claim: waiting runs whose event already arrived
CREATE INDEX waits_resolved_unconsumed ON waits (run_id) WHERE resolved_at IS NOT NULL AND consumed_at IS NULL;

-- claim: waiting runs whose timer is due
CREATE INDEX runs_waiting ON runs (queue, run_after) WHERE status = 'waiting';
