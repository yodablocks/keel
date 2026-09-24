import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine, defaultPolicy } from "../src/index.ts";
import type { TaskContext } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

async function status(engine: ReturnType<typeof createEngine>, id: string, want: string, timeoutMs = 5000) {
  return waitFor(async () => {
    const r = await engine.getRun(id);
    return r?.status === want && r;
  }, timeoutMs, `run to be ${want}`);
}

// Each step costs $0.06 on the default model and $0.01 on the fallback.
function agent(models: string[], steps: string[]) {
  return async (_payload: unknown, ctx: TaskContext) => {
    for (const name of steps) {
      await ctx.step.run(
        name,
        () => {
          models.push(`${name}:${ctx.fallback ?? "gpt-4o"}`);
          return name;
        },
        { usage: () => ({ usd: ctx.fallback ? 0.01 : 0.06 }) },
      );
    }
    return "done";
  };
}

test("an over-budget run falls back to the cheaper model and finishes without a person", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const models: string[] = [];
  const worker = engine.createWorker({
    queue,
    policy: defaultPolicy({ fallback: { target: "gpt-4o-mini", extendBudget: { usd: 0.05 } } }),
    tasks: { agent: agent(models, ["research", "draft", "polish", "send"]) },
  });
  t.after(async () => {
    await worker.stop();
    await engine.close();
  });
  worker.start();

  const { id } = await engine.enqueue("agent", {}, { queue, budget: { usd: 0.1 } });
  const run = await status(engine, id, "completed");

  assert.deepEqual(models, ["research:gpt-4o", "draft:gpt-4o", "polish:gpt-4o-mini", "send:gpt-4o-mini"]);
  assert.equal(run.errors[0]?.kind, "over_budget");
  assert.deepEqual(run.errors[0]?.action, { type: "fallback", target: "gpt-4o-mini", extendBudget: { usd: 0.05 } });
  assert.equal((await engine.listPendingApprovals()).filter((a) => a.runId === id).length, 0);
});

test("a run that goes over budget again on the fallback escalates to a person", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const models: string[] = [];
  const worker = engine.createWorker({
    queue,
    // The extension is too small for even one more step.
    policy: defaultPolicy({ fallback: { target: "gpt-4o-mini", extendBudget: { usd: 0.001 } } }),
    tasks: { agent: agent(models, ["research", "draft", "polish"]) },
  });
  t.after(async () => {
    await worker.stop();
    await engine.close();
  });
  worker.start();

  const { id } = await engine.enqueue("agent", {}, { queue, budget: { usd: 0.1 } });
  const run = await status(engine, id, "waiting");

  assert.deepEqual(run.errors.map((e) => e.action.type), ["fallback", "escalate"]);
  assert.deepEqual(models, ["research:gpt-4o", "draft:gpt-4o"]);
  assert.equal((await engine.listPendingApprovals()).filter((a) => a.runId === id).length, 1);
});
