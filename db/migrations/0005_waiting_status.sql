-- M5: runs suspended on a wait. Separate file because a new enum value cannot be used in the transaction that adds it.
ALTER TYPE run_status ADD VALUE IF NOT EXISTS 'waiting';
