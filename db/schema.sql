-- Schema draft for M1 (queue). Later milestones add tables via new files, not edits here.

CREATE TYPE run_status AS ENUM ('queued', 'running', 'completed', 'failed', 'dead');

CREATE TABLE runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue          text        NOT NULL DEFAULT 'default',
  task           text        NOT NULL,
  payload        jsonb       NOT NULL DEFAULT '{}',
  status         run_status  NOT NULL DEFAULT 'queued',
  attempt        integer     NOT NULL DEFAULT 0,
  max_attempts   integer     NOT NULL DEFAULT 3,
  run_after      timestamptz NOT NULL DEFAULT now(),
  lease_owner    text,
  lease_expires  timestamptz,
  last_error     jsonb,
  result         jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Claim path: SELECT ... WHERE status = 'queued' AND run_after <= now() ORDER BY run_after FOR UPDATE SKIP LOCKED
CREATE INDEX runs_claimable ON runs (queue, run_after) WHERE status = 'queued';

-- Reaper path: running runs whose lease has expired
CREATE INDEX runs_leased ON runs (lease_expires) WHERE status = 'running';
