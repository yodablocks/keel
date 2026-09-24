import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/index.ts";
import type { Approval, TaskHandler } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

function setup(t: import("node:test").TestContext, tasks: Record<string, TaskHandler>) {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const requested: Approval[] = [];
  const worker = engine.createWorker({ queue, tasks, onApprovalRequested: async (a) => void requested.push(a) });
  t.after(async () => {
    await worker.stop();
    await engine.close();
  });
  worker.start();
  return { engine, queue, requested };
}

async function status(engine: ReturnType<typeof createEngine>, id: string, want: string, timeoutMs = 5000) {
  return waitFor(async () => {
    const r = await engine.getRun(id);
    return r?.status === want && r;
  }, timeoutMs, `run to be ${want}`);
}

const refund = (timeoutMs = 60_000): TaskHandler => async (payload, ctx) =>
  ctx.approval.request("refund-ok", {
    prompt: `Approve a refund of $${(payload as { amount: number }).amount}?`,
    timeoutMs,
  });

test("an approved request resumes the run with the reviewer's decision", async (t) => {
  const { engine, queue, requested } = setup(t, { refund: refund() });

  const { id } = await engine.enqueue("refund", { amount: 900 }, { queue });
  await status(engine, id, "waiting");

  const pending = (await engine.listPendingApprovals()).filter((a) => a.runId === id);
  assert.deepEqual(pending.map((a) => [a.name, a.prompt]), [["refund-ok", "Approve a refund of $900?"]]);

  const resolved = await engine.resolveApproval(id, "refund-ok", { approved: true, by: "alice", comment: "customer is VIP" });
  const run = await status(engine, id, "completed");

  assert.equal(resolved.resolved, true);
  assert.deepEqual(run.result, { status: "approved", by: "alice", comment: "customer is VIP" });
  assert.equal((await engine.listPendingApprovals()).filter((a) => a.runId === id).length, 0);
  assert.deepEqual(requested.map((a) => [a.runId, a.name]), [[id, "refund-ok"]], "notified once, not again on replay");
});
