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
