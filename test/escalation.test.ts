import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine, NeedsHumanError } from "../src/index.ts";
import type { Approval, TaskContext } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

function setup(t: import("node:test").TestContext, escalationTimeoutMs?: number) {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const requested: Approval[] = [];
  const hints: Array<string | undefined> = [];
  const worker = engine.createWorker({
    queue,
    ...(escalationTimeoutMs !== undefined && { escalationTimeoutMs }),
    onApprovalRequested: (a) => void requested.push(a),
    tasks: {
      refund: async (_payload: unknown, ctx: TaskContext) => {
        hints.push(ctx.hint);
        if (!ctx.hint) throw new NeedsHumanError("refund of $900 is over the $500 auto-approve limit");
        return `refunded (${ctx.hint})`;
      },
    },
  });
  t.after(async () => {
    await worker.stop();
    await engine.close();
  });
  worker.start();
  return { engine, queue, requested, hints };
}

async function status(engine: ReturnType<typeof createEngine>, id: string, want: string, timeoutMs = 5000) {
  return waitFor(async () => {
    const r = await engine.getRun(id);
    return r?.status === want && r;
  }, timeoutMs, `run to be ${want}`);
}

test("an escalated run waits for a person, and approval retries it with their comment as the hint", async (t) => {
  const { engine, queue, requested, hints } = setup(t);

  const { id } = await engine.enqueue("refund", {}, { queue, maxAttempts: 1 });
  await status(engine, id, "waiting");

  assert.equal(requested.length, 1);
  assert.equal(requested[0]!.runId, id);
  assert.match(requested[0]!.prompt, /over the \$500 auto-approve limit/);

  await engine.resolveApproval(id, requested[0]!.name, { approved: true, by: "alice", comment: "limit raised for this customer" });
  const run = await status(engine, id, "completed");

  assert.equal(run.result, "refunded (limit raised for this customer)");
  assert.deepEqual(hints, [undefined, "limit raised for this customer"]);
  assert.equal(run.attempt, 2, "approval grants one more attempt even past maxAttempts");
});

test("a rejected escalation fails the run without running it again", async (t) => {
  const { engine, queue, requested, hints } = setup(t);

  const { id } = await engine.enqueue("refund", {}, { queue });
  await status(engine, id, "waiting");
  await engine.resolveApproval(id, requested[0]!.name, { approved: false, by: "bob" });
  await status(engine, id, "failed");

  assert.equal(hints.length, 1);
});

test("an escalation nobody answers fails the run after the escalation timeout", async (t) => {
  const { engine, queue, hints } = setup(t, 300);

  const { id } = await engine.enqueue("refund", {}, { queue });
  await status(engine, id, "waiting");
  await status(engine, id, "failed");

  assert.equal(hints.length, 1);
});
