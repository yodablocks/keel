-- M8 approvals: an approval is a wait on a keel-owned event, with a prompt for the reviewer.
ALTER TABLE waits ADD COLUMN kind text NOT NULL DEFAULT 'wait';
ALTER TABLE waits ADD COLUMN prompt text;

CREATE INDEX waits_pending_approvals ON waits (created_at)
  WHERE kind IN ('approval', 'escalation') AND resolved_at IS NULL AND consumed_at IS NULL;
