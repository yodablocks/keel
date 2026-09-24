import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEngine, defaultPolicy } from "../src/index.ts";
import type { TaskHandler } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

function setup(t: import("node:test").TestContext, tasks: Record<string, TaskHandler>) {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const worker = engine.createWorker({ queue, tasks, policy: defaultPolicy({ baseMs: 10 }) });
  t.after(async () => {
    await worker.stop();
    await engine.close();
  });
  worker.start();
  return { engine, queue, tenant: `tenant-${randomUUID()}` };
}

async function status(engine: ReturnType<typeof createEngine>, id: string, want: string, timeoutMs = 5000) {
  return waitFor(async () => {
    const r = await engine.getRun(id);
    return r?.status === want && r;
  }, timeoutMs, `run to be ${want}`);
}

const cost = (usd: number, tokens: number) => ({ usage: () => ({ usd, tokens }) });

test("step usage adds up on the run and a retry does not count it twice", async (t) => {
  let attempts = 0;
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      await ctx.step.run("plan", () => "plan", cost(0.25, 1000));
      await ctx.step.run("draft", () => "draft", cost(0.5, 3000));
      attempts++;
      if (attempts === 1) throw Object.assign(new Error("HTTP 503"), { status: 503 });
      return "done";
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue });
  const run = await status(engine, id, "completed");

  assert.equal(run.attempt, 2);
  assert.deepEqual(run.usage, { usd: 0.75, tokens: 4000 });
});

test("a run over its budget stops before the next step and escalates", async (t) => {
  const called: string[] = [];
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      for (const name of ["research", "draft", "polish"]) {
        await ctx.step.run(name, () => called.push(name), cost(0.6, 0));
      }
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue, budget: { usd: 1 } });
  const run = await status(engine, id, "failed");

  assert.deepEqual(called, ["research", "draft"], "the step after the budget was crossed never ran");
  assert.equal(run.usage.usd, 1.2, "overshoot is at most one step");
  assert.equal(run.errors[0]?.kind, "over_budget");
  assert.equal(run.errors[0]?.action.type, "escalate");
});
