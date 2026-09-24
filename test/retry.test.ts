import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine, defaultPolicy } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function setup(t: import("node:test").TestContext) {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const workers: Array<{ stop(): Promise<void> }> = [];
  t.after(async () => {
    await Promise.all(workers.map((w) => w.stop()));
    await engine.close();
  });
  return { engine, queue, workers };
}

async function settled(engine: ReturnType<typeof createEngine>, id: string) {
  return waitFor(async () => {
    const r = await engine.getRun(id);
    return r && ["completed", "failed", "dead"].includes(r.status) && r;
  }, 8000, "run to settle");
}

test("a transient failure is retried with backoff until it succeeds", async (t) => {
  const { engine, queue, workers } = setup(t);
  const calls: number[] = [];

  const worker = engine.createWorker({
    queue,
    policy: defaultPolicy({ baseMs: 100, maxMs: 1000 }),
    tasks: {
      flaky: async (_payload, ctx) => {
        calls.push(Date.now());
        if (ctx.attempt < 3) throw httpError(503);
        return "third time lucky";
      },
    },
  });
  workers.push(worker);
  worker.start();

  const { id } = await engine.enqueue("flaky", {}, { queue, maxAttempts: 5 });
  const run = await settled(engine, id);

  assert.equal(run.status, "completed");
  assert.equal(run.result, "third time lucky");
  assert.equal(run.attempt, 3);
  assert.deepEqual(run.errors.map((e) => [e.attempt, e.kind, e.message]), [
    [1, "transient", "HTTP 503"],
    [2, "transient", "HTTP 503"],
  ]);
  // Full jitter: each wait is random in [0, base * 2^(attempt-1)], plus polling overhead.
  const slack = 250;
  assert.ok(calls[1]! - calls[0]! <= 100 + slack, `first backoff ${calls[1]! - calls[0]!}ms`);
  assert.ok(calls[2]! - calls[1]! <= 200 + slack, `second backoff ${calls[2]! - calls[1]!}ms`);
});
