-- M15: every step added to one tenant_spend/task_spend row per day, so busy tenants and tasks serialized on
-- that row's lock (measured: 32 workers fell from about 2,200 to 1,600 runs/s). Spend is now spread over
-- 16 shard rows per day; budget checks sum them.
ALTER TABLE task_spend ADD COLUMN shard smallint NOT NULL DEFAULT 0;
ALTER TABLE task_spend DROP CONSTRAINT task_spend_pkey;
ALTER TABLE task_spend ADD PRIMARY KEY (task, day, shard);

ALTER TABLE tenant_spend ADD COLUMN shard smallint NOT NULL DEFAULT 0;
ALTER TABLE tenant_spend DROP CONSTRAINT tenant_spend_pkey;
ALTER TABLE tenant_spend ADD PRIMARY KEY (tenant, day, shard);
