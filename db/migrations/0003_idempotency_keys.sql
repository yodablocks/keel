-- M3 idempotency: one live key per task. An expired key is taken over by the next enqueue.
CREATE TABLE idempotency_keys (
  task        text        NOT NULL,
  key         text        NOT NULL,
  run_id      uuid        NOT NULL,
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (task, key)
);
