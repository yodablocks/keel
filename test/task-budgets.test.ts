import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEngine } from "../src/index.ts";
import type { TaskHandler } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

function setup(t: import("node:test").TestContext, tasks: (task: string) => Record<string, TaskHandler>) {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  // Task budgets are global per task name, so each test uses its own.
  const task = `agent-${randomUUID()}`;
  const worker = engine.createWorker({ queue, tasks: tasks(task) });
  t.after(async () => {
    await worker.stop();
    await engine.close();
  });
  worker.start();
  return { engine, queue, task };
}

async function status(engine: ReturnType<typeof createEngine>, id: string, want: string, timeoutMs = 5000) {
  return waitFor(async () => {
    const r = await engine.getRun(id);
    return r?.status === want && r;
  }, timeoutMs, `run to be ${want}`);
}

const threeSteps: TaskHandler = async (_payload, ctx) => {
  for (const name of ["a", "b", "c"]) await ctx.step.run(name, () => name, { usage: () => ({ usd: 0.06 }) });
  return "done";
};

test("a task's per-run budget applies to runs enqueued without one, and an explicit budget overrides it", async (t) => {
  const { engine, queue, task } = setup(t, (task) => ({ [task]: threeSteps }));
  await engine.setTaskBudget(task, { usdPerRun: 0.1 });

  const defaulted = await engine.enqueue(task, {}, { queue });
  const explicit = await engine.enqueue(task, {}, { queue, budget: { usd: 1 } });

  const stopped = await status(engine, defaulted.id, "waiting");
  assert.equal(stopped.errors[0]?.kind, "over_budget");
  await status(engine, explicit.id, "completed");
});
