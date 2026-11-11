import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEngine, defaultPolicy, startDashboard } from "../src/index.ts";
import type { TaskHandler } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

// call.reportUsage: a step reports what it cost as soon as it knows, so a model call that was billed and then
// failed (bad output, a parse error) still counts against the budget.

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

async function status(engine: ReturnType<typeof createEngine>, id: string, want: string) {
  return waitFor(async () => {
    const r = await engine.getRun(id);
    return r?.status === want && r;
  }, 5000, `run to be ${want}`);
}

// USD is a float sum and SQL does not fix the order it adds rows in, so compare to the cent.
function assertUsd(actual: number, expected: number, message?: string) {
  assert.ok(Math.abs(actual - expected) < 0.005, message ?? `expected $${expected}, got $${actual}`);
}

const http503 = () => Object.assign(new Error("HTTP 503: model overloaded"), { status: 503 });

test("a step that is billed and then fails counts against the budget, so retries stop at it", async (t) => {
  let calls = 0;
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      await ctx.step.run("draft", (call) => {
        calls++;
        call.reportUsage({ usd: 0.6, tokens: 3000 }); // the model replied and billed
        throw http503(); // then something after the reply failed
      });
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue, budget: { usd: 1 } });
  const run = await status(engine, id, "waiting");

  assert.equal(calls, 2, "the third attempt is refused: $1.20 is over the $1 budget");
  assertUsd(run.usage.usd, 1.2);
  assert.equal(run.usage.tokens, 6000);
  assertUsd(run.failedUsage.usd, 1.2);
  assert.equal(run.errors.at(-1)?.kind, "over_budget");
});

test("a failing step that reports nothing costs nothing, as before", async (t) => {
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      await ctx.step.run("draft", () => {
        throw new TypeError("bug");
      });
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue, maxAttempts: 1 });
  const run = await status(engine, id, "failed");
  assert.deepEqual(run.usage, { usd: 0, tokens: 0 });
  assert.deepEqual(run.failedUsage, { usd: 0, tokens: 0 });
});

test("a step that reports and then succeeds is counted once, with its usage option, and not again on replay", async (t) => {
  let attempts = 0;
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      await ctx.step.run("draft", (call) => {
        call.reportUsage({ usd: 0.25 });
        call.reportUsage({ tokens: 500 });
        return { extraUsd: 0.1 };
      }, { usage: (r) => ({ usd: r.extraUsd }) });
      attempts++;
      if (attempts === 1) throw http503();
      return "done";
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue });
  const run = await status(engine, id, "completed");
  assert.equal(run.attempt, 2);
  assertUsd(run.usage.usd, 0.35);
  assert.equal(run.usage.tokens, 500);
  assert.deepEqual(run.failedUsage, { usd: 0, tokens: 0 });
});

test("a failed step's cost counts toward the tenant's daily budget", async (t) => {
  const { engine, queue, tenant } = setup(t, {
    fails: async (_payload, ctx) => {
      await ctx.step.run("draft", (call) => {
        call.reportUsage({ usd: 1 });
        throw new TypeError("could not parse the reply");
      });
    },
    works: async (_payload, ctx) => ctx.step.run("a", () => "a"),
  });
  await engine.setTenantBudget(tenant, { usdPerDay: 1 });

  const failed = await engine.enqueue("fails", {}, { queue, tenant, maxAttempts: 1 });
  await status(engine, failed.id, "failed");

  const deferred = await engine.enqueue("works", {}, { queue, tenant });
  const other = await engine.enqueue("works", {}, { queue, tenant: `${tenant}-other` });
  await status(engine, other.id, "completed");
  assert.equal((await engine.getRun(deferred.id))?.status, "queued", "the tenant is at its budget");
});

test("a handler that catches a failed step still has its cost checked by the next step's maxUsd", async (t) => {
  const called: string[] = [];
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      try {
        await ctx.step.run("first", (call) => {
          call.reportUsage({ usd: 0.6 });
          throw new Error("unusable reply");
        });
      } catch {
        // falls back to another approach
      }
      await ctx.step.run("second", () => called.push("second"), { maxUsd: 0.6 });
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue, budget: { usd: 1 } });
  const run = await status(engine, id, "waiting");
  assert.deepEqual(called, []);
  assert.equal(run.errors[0]?.kind, "over_budget");
});

test("the dashboard says how much of a run's spend came from failed steps", async (t) => {
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      await ctx.step.run("ok", () => "ok", { usage: () => ({ usd: 0.02 }) });
      await ctx.step.run("draft", (call) => {
        call.reportUsage({ usd: 0.5, tokens: 1200 });
        throw new TypeError("could not parse the reply");
      });
    },
  });
  const dashboard = await startDashboard({ engine, port: 0, refreshSeconds: 0 });
  t.after(() => dashboard.close());

  const { id } = await engine.enqueue("agent", {}, { queue, maxAttempts: 1 });
  await status(engine, id, "failed");
  const page = await (await fetch(`${dashboard.url}/runs/${id}`)).text();
  assert.match(page, /incl\. \$0\.50 · 1,200 tok from failed steps/);
});

test("an invalid reported amount is a programming error, and the step's own error is not hidden", async (t) => {
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      await ctx.step.run("draft", (call) => {
        call.reportUsage({ usd: -1 });
        return "unreachable";
      });
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue, maxAttempts: 1 });
  const run = await status(engine, id, "failed");
  assert.match(run.errors[0]!.message, /reportUsage: usd must be a number, 0 or more/);
});
