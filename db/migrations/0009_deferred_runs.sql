-- M10: runs of an over-budget tenant are parked (run_after moved to the next UTC midnight) so the claim
-- query skips them through its index. The original run_after is kept here and restored on release.
ALTER TABLE runs ADD COLUMN deferred_run_after timestamptz;
CREATE INDEX runs_deferred_by_tenant ON runs (tenant) WHERE deferred_run_after IS NOT NULL;
