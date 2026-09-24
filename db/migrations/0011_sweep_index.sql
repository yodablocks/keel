-- The budget sweep looks for a queue's queued or waiting runs that are not parked yet. Without this index
-- it scanned the whole runs table on every sweep (about 170ms at 72,000 rows, blocking claims meanwhile).
CREATE INDEX runs_sweepable ON runs (queue) WHERE status IN ('queued', 'waiting') AND deferred_run_after IS NULL;
