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

// USD is a float sum and SQL does not fix the order it adds rows in, so compare to the cent.
function assertUsd(actual: number, expected: number, message?: string) {
  assert.ok(Math.abs(actual - expected) < 0.005, message ?? `expected $${expected}, got $${actual}`);
}

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
  assertUsd(run.usage.usd, 0.75);
  assert.equal(run.usage.tokens, 4000);
});

test("a run over its budget stops before the next step and escalates to a person", async (t) => {
  const called: string[] = [];
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      for (const name of ["research", "draft", "polish"]) {
        await ctx.step.run(name, () => called.push(name), cost(0.6, 0));
      }
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue, budget: { usd: 1 } });
  const run = await status(engine, id, "waiting");

  assert.deepEqual(called, ["research", "draft"], "the step after the budget was crossed never ran");
  assertUsd(run.usage.usd, 1.2, "overshoot is at most one step");
  assert.equal(run.errors[0]?.kind, "over_budget");
  assert.equal(run.errors[0]?.action.type, "escalate");
});

test("a tenant at its daily budget has new runs deferred, not failed, until the budget allows", async (t) => {
  const { engine, queue, tenant } = setup(t, {
    agent: async (_payload, ctx) => {
      await ctx.step.run("a", () => "a", cost(0.6, 0));
      await ctx.step.run("b", () => "b", cost(0.6, 0));
      return "done";
    },
  });
  await engine.setTenantBudget(tenant, { usdPerDay: 1 });

  const first = await engine.enqueue("agent", {}, { queue, tenant });
  await status(engine, first.id, "completed");

  const deferred = await engine.enqueue("agent", {}, { queue, tenant });
  const otherTenant = await engine.enqueue("agent", {}, { queue, tenant: `${tenant}-other` });
  await status(engine, otherTenant.id, "completed");
  assert.equal((await engine.getRun(deferred.id))?.status, "queued", "over-budget tenant's run is left queued");

  await engine.setTenantBudget(tenant, { usdPerDay: 10 });
  const run = await status(engine, deferred.id, "completed");
  assert.equal(run.attempt, 1);
});

test("a run whose tenant hits its limit mid-way pauses at the next step and resumes when allowed", async (t) => {
  const calls = { a: 0, b: 0, c: 0 };
  let entries = 0;
  const { engine, queue, tenant } = setup(t, {
    agent: async (_payload, ctx) => {
      entries++;
      await ctx.step.run("a", () => calls.a++, cost(0.6, 0));
      await ctx.step.run("b", () => calls.b++, cost(0.6, 0));
      await ctx.step.run("c", () => calls.c++, cost(0.1, 0));
      return "done";
    },
  });
  await engine.setTenantBudget(tenant, { usdPerDay: 1 });

  const { id } = await engine.enqueue("agent", {}, { queue, tenant });
  await status(engine, id, "waiting");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(calls, { a: 1, b: 1, c: 0 });
  assert.equal(entries, 1, "a paused run is held, not re-claimed in a loop");

  await engine.setTenantBudget(tenant, { usdPerDay: 10 });
  const run = await status(engine, id, "completed");

  assert.deepEqual(calls, { a: 1, b: 1, c: 1 });
  assert.equal(run.attempt, 1, "pausing for budget is not a failed attempt");
  assertUsd(run.usage.usd, 1.3);
});

test("a reviewer can raise a run's budget and approve its escalation so it finishes", async (t) => {
  const called: string[] = [];
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      for (const name of ["research", "draft", "polish"]) {
        await ctx.step.run(name, () => called.push(name), cost(0.6, 0));
      }
      return "done";
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue, budget: { usd: 1 } });
  await status(engine, id, "waiting");
  const [escalation] = (await engine.listPendingApprovals()).filter((a) => a.runId === id);

  await engine.setRunBudget(id, { usd: 5 });
  await engine.resolveApproval(id, escalation!.name, { approved: true, by: "alice", comment: "budget raised to $5" });
  const run = await status(engine, id, "completed");

  assert.deepEqual(called, ["research", "draft", "polish"]);
  assertUsd(run.usage.usd, 1.8);
});
