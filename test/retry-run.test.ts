import { test } from "node:test";
import assert from "node:assert/strict";
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
  return { engine, queue };
}

async function status(engine: ReturnType<typeof createEngine>, id: string, want: string) {
  return waitFor(async () => {
    const r = await engine.getRun(id);
    return r?.status === want && r;
  }, 5000, `run to be ${want}`);
}

test("a failed run retried by hand resumes after its completed steps, with the same step keys", async (t) => {
  let fetches = 0;
  let sendFails = true;
  const keys: string[] = [];
  const { engine, queue } = setup(t, {
    report: async (_payload, ctx) => {
      const data = await ctx.step.run("fetch", () => ++fetches);
      return ctx.step.run("send", (call) => {
        keys.push(call.idempotencyKey);
        if (sendFails) throw new Error("mailbox not configured"); // no signal: the rules say fatal
        return `sent ${data}`;
      });
    },
  });

  const { id } = await engine.enqueue("report", {}, { queue });
  const failed = await status(engine, id, "failed");
  assert.equal(failed.errors.length, 1);

  sendFails = false;
  assert.deepEqual(await engine.retryRun(id), { retried: true });
  const run = await status(engine, id, "completed");

  assert.equal(run.result, "sent 1");
  assert.equal(fetches, 1, "the completed step was replayed from storage, not run again");
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], "the step's idempotency key is the same after the manual retry");
  assert.equal(run.errors.length, 1, "the earlier failure stays in the history");
  assert.equal(run.attempt, 2);
});

test("a dead run gets the attempts it is retried with, and a hint reaches the handler", async (t) => {
  let calls = 0;
  const hints: Array<string | undefined> = [];
  const { engine, queue } = setup(t, {
    flaky: async (_payload, ctx) => {
      calls++;
      hints.push(ctx.hint);
      if (calls < 4) throw Object.assign(new Error("HTTP 503"), { status: 503 });
      return "up again";
    },
  });

  const { id } = await engine.enqueue("flaky", {}, { queue, maxAttempts: 2 });
  await status(engine, id, "dead");
  assert.equal(calls, 2);

  assert.deepEqual(await engine.retryRun(id, { attempts: 2, hint: "the provider is back up" }), { retried: true });
  const run = await status(engine, id, "completed");

  assert.equal(calls, 4);
  assert.equal(run.attempt, 4);
  assert.equal(hints[2], "the provider is back up");
});

test("retryRun only retries failed or dead runs, and only once when called twice at the same time", async (t) => {
  let fail = true;
  const { engine, queue } = setup(t, {
    once: async () => {
      if (fail) throw new Error("bad config");
      return "ok";
    },
  });

  assert.deepEqual(await engine.retryRun("00000000-0000-0000-0000-000000000000"), { retried: false });

  const { id } = await engine.enqueue("once", {}, { queue });
  await status(engine, id, "failed");
  fail = false;
  const results = await Promise.all([engine.retryRun(id), engine.retryRun(id)]);
  assert.deepEqual(results.map((r) => r.retried).sort(), [false, true]);

  await status(engine, id, "completed");
  assert.deepEqual(await engine.retryRun(id), { retried: false }, "a completed run is not retried");
});

test("retryRun rejects a number of attempts below 1", async (t) => {
  const { engine } = setup(t, {});
  await assert.rejects(engine.retryRun("00000000-0000-0000-0000-000000000000", { attempts: 0 }), /attempts/);
});
