import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine, defaultPolicy } from "../src/index.ts";
import type { TaskHandler } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

// maxUsd: a step declares the most it can cost, and keel refuses to start it when that could cross the run's
// budget, instead of finding out after it ran.

function setup(t: import("node:test").TestContext, tasks: Record<string, TaskHandler>) {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const worker = engine.createWorker({ queue, tasks, policy: defaultPolicy({ baseMs: 10 }) });
  t.after(async () => {
    await worker.stop();
    await engine.close();
  });
  worker.start();
  return { engine, queue };
}

async function status(engine: ReturnType<typeof createEngine>, id: string, want: string) {
  return waitFor(async () => {
    const r = await engine.getRun(id);
    return r?.status === want && r;
  }, 5000, `run to be ${want}`);
}

const step = (usd: number, maxUsd?: number) => ({ usage: () => ({ usd }), ...(maxUsd !== undefined && { maxUsd }) });

// USD is a float sum and SQL does not fix the order it adds rows in, so compare to the cent.
function assertUsd(actual: number, expected: number, message?: string) {
  assert.ok(Math.abs(actual - expected) < 0.005, message ?? `expected $${expected}, got $${actual}`);
}

test("a step whose declared maximum could cross the budget never starts, so the budget is not overshot", async (t) => {
  const called: string[] = [];
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      await ctx.step.run("research", () => called.push("research"), step(0.6, 0.6));
      await ctx.step.run("draft", () => called.push("draft"), step(0.6, 0.6));
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue, budget: { usd: 1 } });
  const run = await status(engine, id, "waiting");

  assert.deepEqual(called, ["research"]);
  assertUsd(run.usage.usd, 0.6, "spend stays under the budget");
  assert.equal(run.errors[0]?.kind, "over_budget");
  assert.equal(run.errors[0]?.action.type, "escalate");
  assert.match(run.errors[0]!.message, /step "draft" could cost up to \$0\.6/);
});

test("a step whose declared maximum fits the budget exactly runs", async (t) => {
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      await ctx.step.run("research", () => "r", step(0.4, 0.4));
      await ctx.step.run("draft", () => "d", step(0.5, 0.6));
      return "done";
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue, budget: { usd: 1 } });
  const run = await status(engine, id, "completed");
  assertUsd(run.usage.usd, 0.9);
});

test("steps run in parallel cannot both pass the check against the same spend", async (t) => {
  const called: string[] = [];
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      await Promise.all([
        ctx.step.run("a", async () => {
          called.push("a");
          await new Promise((r) => setTimeout(r, 50));
        }, step(0.6, 0.6)),
        ctx.step.run("b", () => called.push("b"), step(0.6, 0.6)),
      ]);
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue, budget: { usd: 1 } });
  const run = await status(engine, id, "waiting");
  assert.deepEqual(called, ["a"], "the second step saw the first one's reservation");
  assert.equal(run.errors[0]?.kind, "over_budget");

  // "a" was still running when "b" was refused. Its result and cost are stored, not lost.
  assertUsd(run.usage.usd, 0.6, "the step that was running when the run stopped is counted");

  const escalation = await waitFor(
    async () => (await engine.listPendingApprovals()).find((x) => x.runId === id),
    5000,
    "the over-budget escalation",
  );
  await engine.setRunBudget(id, { usd: 2 });
  await engine.resolveApproval(id, escalation.name, { approved: true, by: "alice" });
  const done = await status(engine, id, "completed");
  assert.deepEqual(called, ["a", "b"], "after approval, a replays from storage instead of running again");
  assertUsd(done.usage.usd, 1.2);
});

test("a step that fits exactly is not refused by float rounding", async (t) => {
  // In floating point, 0.1 + 0.1 + 0.1 > 0.3.
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      await ctx.step.run("a", () => "a", step(0.1, 0.1));
      await ctx.step.run("b", () => "b", step(0.1, 0.1));
      await ctx.step.run("c", () => "c", step(0.1, 0.1));
      return "done";
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue, budget: { usd: 0.3 } });
  await status(engine, id, "completed");
});

test("a run with no USD budget ignores maxUsd", async (t) => {
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      await ctx.step.run("big", () => "b", step(5, 100));
      return "done";
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue });
  await status(engine, id, "completed");
});

test("raising the budget and approving lets the refused step run", async (t) => {
  const called: string[] = [];
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      await ctx.step.run("research", () => called.push("research"), step(0.6, 0.6));
      await ctx.step.run("draft", () => called.push("draft"), step(0.6, 0.6));
      return "done";
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue, budget: { usd: 1 } });
  await status(engine, id, "waiting");
  const escalation = await waitFor(
    async () => (await engine.listPendingApprovals()).find((a) => a.runId === id),
    5000,
    "the over-budget escalation",
  );

  await engine.setRunBudget(id, { usd: 2 });
  await engine.resolveApproval(id, escalation.name, { approved: true, by: "alice" });
  const run = await status(engine, id, "completed");

  assert.deepEqual(called, ["research", "draft"], "the stored step is not run again");
  assertUsd(run.usage.usd, 1.2);
});

test("an invalid maxUsd is a programming error", async (t) => {
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      await ctx.step.run("x", () => "x", { maxUsd: -1 });
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue, budget: { usd: 1 }, maxAttempts: 1 });
  const run = await waitFor(async () => {
    const r = await engine.getRun(id);
    return r && r.errors.length > 0 && r;
  }, 5000, "the run to record an error");
  assert.match(run.errors[0]!.message, /maxUsd must be a number of dollars, 0 or more/);
});
