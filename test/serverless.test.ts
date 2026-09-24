import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createEngine } from "../src/index.ts";
import type { TaskHandler } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";

function setup(t: import("node:test").TestContext, tasks: Record<string, TaskHandler>) {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  // Never started: every test drives it with runOnce, like a cron job or a serverless function would.
  const worker = engine.createWorker({ queue, tasks });
  t.after(() => engine.close());
  return { engine, queue, worker };
}

test("a run with steps and a wait completes across several runOnce calls with no long-lived worker", async (t) => {
  const executed: string[] = [];
  const { engine, queue, worker } = setup(t, {
    agent: async (_payload, ctx) => {
      await ctx.step.run("research", () => executed.push("research"));
      await ctx.step.run("draft", () => executed.push("draft"));
      await ctx.wait.for("cool-off", 300);
      await ctx.step.run("send", () => executed.push("send"));
      return "sent";
    },
  });
  const { id } = await engine.enqueue("agent", {}, { queue });

  const first = await worker.runOnce();
  assert.deepEqual([first.claimed, first.suspended], [1, 1]);
  assert.equal((await engine.getRun(id))?.status, "waiting");

  const tooEarly = await worker.runOnce();
  assert.equal(tooEarly.claimed, 0, "nothing is due while the wait is pending");

  await sleep(350);
  const last = await worker.runOnce();
  assert.equal(last.completed, 1);

  const run = await engine.getRun(id);
  assert.equal(run?.result, "sent");
  assert.deepEqual(executed, ["research", "draft", "send"], "no step ran twice");
});
