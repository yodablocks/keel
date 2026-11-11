-- Cost that steps reported with call.reportUsage before they failed: a model call that was billed and then
-- failed has no step row, so its cost is kept on the run. Run usage is the steps' sum plus these.
ALTER TABLE runs ADD COLUMN failed_usd double precision NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN failed_tokens double precision NOT NULL DEFAULT 0;
