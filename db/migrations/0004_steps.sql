-- M4 durable steps: one row per completed step. Replays return the stored result instead of re-running it.
CREATE TABLE steps (
  run_id        uuid        NOT NULL,
  name          text        NOT NULL,
  result        jsonb       NOT NULL,
  attempt       integer     NOT NULL,
  completed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, name)
);
