import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/index.ts";
import type { TaskHandler } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

function setup(t: import("node:test").TestContext, tasks: Record<string, TaskHandler>) {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const worker = engine.createWorker({ queue, tasks });
  t.after(async () => {
    await worker.stop();
    await engine.close();
  });
  worker.start();
  return { engine, queue };
}

async function status(engine: ReturnType<typeof createEngine>, id: string, want: string, timeoutMs = 5000) {
  return waitFor(async () => {
    const r = await engine.getRun(id);
    return r?.status === want && r;
  }, timeoutMs, `run to be ${want}`);
}

test("wait.for suspends the run and resumes it after the delay without re-running earlier steps", async (t) => {
  let before = 0;
  let resumedAt = 0;
  const { engine, queue } = setup(t, {
    cooloff: async (_payload, ctx) => {
      await ctx.step.run("before", () => before++);
      await ctx.wait.for("cool-off", 400);
      resumedAt = Date.now();
      return "after the wait";
    },
  });

  const enqueuedAt = Date.now();
  const { id } = await engine.enqueue("cooloff", {}, { queue });
  await status(engine, id, "waiting");
  const run = await status(engine, id, "completed");

  assert.equal(run.result, "after the wait");
  assert.ok(resumedAt - enqueuedAt >= 400, `resumed after ${resumedAt - enqueuedAt}ms`);
  assert.equal(before, 1);
  assert.equal(run.attempt, 1, "resuming is not a new attempt");
});

test("100 runs waiting an hour hold no worker: a new run still completes at once", async (t) => {
  const { engine, queue } = setup(t, {
    sleeper: async (_payload, ctx) => {
      await ctx.wait.for("an-hour", 60 * 60_000);
    },
    quick: async () => "done",
  });

  const sleepers = await Promise.all(Array.from({ length: 100 }, () => engine.enqueue("sleeper", {}, { queue })));
  await waitFor(async () => {
    const runs = await Promise.all(sleepers.map((s) => engine.getRun(s.id)));
    return runs.every((r) => r?.status === "waiting");
  }, 10_000, "all 100 runs to be waiting");

  const { id } = await engine.enqueue("quick", {}, { queue });
  const run = await status(engine, id, "completed", 1000);
  assert.equal(run.result, "done");
});

test("forEvent resumes the run with the event payload", async (t) => {
  const { engine, queue } = setup(t, {
    refund: async (payload, ctx) => {
      const orderId = (payload as { orderId: number }).orderId;
      const approval = await ctx.wait.forEvent("approval", `approved:${orderId}`, { timeoutMs: 60_000 });
      return approval;
    },
  });

  const { id } = await engine.enqueue("refund", { orderId: 42 }, { queue });
  await status(engine, id, "waiting");
  const other = await engine.sendEvent("approved:41", { by: "someone else" });
  const sent = await engine.sendEvent("approved:42", { by: "alice" });
  const run = await status(engine, id, "completed");

  assert.equal(other.resolved, 0);
  assert.equal(sent.resolved, 1);
  assert.deepEqual(run.result, { timedOut: false, payload: { by: "alice" } });
});

test("forEvent resumes with timedOut when no event arrives in time", async (t) => {
  const { engine, queue } = setup(t, {
    refund: async (_payload, ctx) => ctx.wait.forEvent("approval", "approved:never", { timeoutMs: 300 }),
  });

  const { id } = await engine.enqueue("refund", {}, { queue });
  await status(engine, id, "waiting");
  const run = await status(engine, id, "completed");

  assert.deepEqual(run.result, { timedOut: true });
  const late = await engine.sendEvent("approved:never", {});
  assert.equal(late.resolved, 0, "an event after the timeout changes nothing");
});
