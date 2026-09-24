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

test("a task at its daily budget has its runs deferred while other tasks keep running, until the limit is raised", async (t) => {
  const { engine, queue, task } = setup(t, (task) => ({ [task]: threeSteps, other: async () => "other done" }));
  await engine.setTaskBudget(task, { usdPerDay: 0.1 });

  // $0.12 spent after two steps: the run pauses before its third.
  const first = await engine.enqueue(task, {}, { queue });
  await status(engine, first.id, "waiting");

  const second = await engine.enqueue(task, {}, { queue });
  const other = await engine.enqueue("other", {}, { queue });
  await status(engine, other.id, "completed");
  assert.equal((await engine.getRun(second.id))?.status, "queued", "the task's new run is deferred, not failed");

  await engine.setTaskBudget(task, { usdPerDay: 10 });
  await status(engine, first.id, "completed");
  const run = await status(engine, second.id, "completed");
  assert.equal(run.attempt, 1);
});
