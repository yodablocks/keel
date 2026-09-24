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
