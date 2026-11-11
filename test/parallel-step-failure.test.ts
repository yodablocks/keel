import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createEngine, defaultPolicy } from "../src/index.ts";
import type { TaskHandler } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

// Two steps run in parallel and one fails: the other is still running when the handler gives up.

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

function assertUsd(actual: number, expected: number, message?: string) {
  assert.ok(Math.abs(actual - expected) < 0.005, message ?? `expected $${expected}, got $${actual}`);
}

test("a step still running when a parallel step fails is stored, not paid for again on the retry", async (t) => {
  const calls = { a: 0, b: 0 };
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      await Promise.all([
        ctx.step.run("a", async () => {
          calls.a++;
          await new Promise((r) => setTimeout(r, 100));
          return "a";
        }, { usage: () => ({ usd: 0.6 }) }),
        ctx.step.run("b", () => {
          calls.b++;
          if (calls.b === 1) throw Object.assign(new Error("HTTP 503"), { status: 503 });
          return "b";
        }),
      ]);
      return "done";
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue });
  const run = await status(engine, id, "completed");

  assert.equal(calls.a, 1, "a finished during the first attempt and replays from storage");
  assertUsd(run.usage.usd, 0.6);
});

test("a step from an earlier attempt cannot store its result into a newer attempt of the same worker", async (t) => {
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  t.after(() => db.end());
  let caught: unknown;
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      try {
        await ctx.step.run("a", async () => {
          // A newer attempt of the run starts while this step is still running.
          await db.query(`UPDATE runs SET attempt = attempt + 1 WHERE id = $1`, [ctx.runId]);
          return "stale";
        }, { usage: () => ({ usd: 0.6 }) });
      } catch (error) {
        caught = error;
      }
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue });
  await waitFor(async () => caught !== undefined, 5000, "the stale step to be refused");
  assert.equal((caught as Error).name, "LeaseLostError");
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM steps WHERE run_id = $1`, [id]);
  assert.equal(rows[0].n, 0, "nothing stored, and so no cost counted");
});

test("a handler that catches a parallel failure and returns still waits for the running step and counts it", async (t) => {
  const calls = { a: 0 };
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      try {
        await Promise.all([
          ctx.step.run("a", async () => {
            calls.a++;
            await new Promise((r) => setTimeout(r, 100));
            return "a";
          }, { usage: () => ({ usd: 0.6 }) }),
          ctx.step.run("b", () => {
            throw new Error("b failed");
          }),
        ]);
      } catch {
        return "gave up on the pair"; // returns while "a" is still running
      }
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue });
  const run = await status(engine, id, "completed");
  assert.equal(calls.a, 1);
  assertUsd(run.usage.usd, 0.6);
});

test("a handler that returns from Promise.race completes after the losing step finishes, and counts it", async (t) => {
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) =>
      Promise.race([
        ctx.step.run("fast", () => "fast", { usage: () => ({ usd: 0.1 }) }),
        ctx.step.run("slow", async () => {
          await new Promise((r) => setTimeout(r, 100));
          return "slow";
        }, { usage: () => ({ usd: 0.6 }) }),
      ]),
  });

  const { id } = await engine.enqueue("agent", {}, { queue });
  const run = await status(engine, id, "completed");
  assert.equal(run.result, "fast");
  assertUsd(run.usage.usd, 0.7, "the losing step was paid for, so it counts");
});

test("a parallel step that never finishes holds the attempt, and stop({ timeoutMs }) still releases the run", async (t) => {
  // Not the shared setup: its plain stop() would wait for the stuck step forever.
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  let started = false;
  const worker = engine.createWorker({
    queue,
    policy: defaultPolicy({ baseMs: 10 }),
    tasks: {
      agent: async (_payload, ctx) => {
        await Promise.all([
          ctx.step.run("stuck", () => {
            started = true;
            return new Promise(() => {}); // a call with no timeout that never answers
          }),
          ctx.step.run("fails", async () => {
            await new Promise((r) => setTimeout(r, 20));
            throw new Error("fails");
          }),
        ]);
      },
    },
  });
  t.after(() => engine.close());
  worker.start();

  const { id } = await engine.enqueue("agent", {}, { queue });
  await waitFor(async () => started, 5000, "the stuck step to start");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await engine.getRun(id))?.status, "running", "the attempt waits for the stuck step");

  await worker.stop({ timeoutMs: 200 });
  assert.equal((await engine.getRun(id))?.status, "queued", "released for another worker");
});
