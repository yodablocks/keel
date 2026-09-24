-- M2 retries: full error history per run, and the corrective hint passed to the next attempt.
ALTER TABLE runs ADD COLUMN errors jsonb NOT NULL DEFAULT '[]';
ALTER TABLE runs ADD COLUMN hint text;
