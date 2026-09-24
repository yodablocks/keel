import { test } from "node:test";
import assert from "node:assert/strict";
import { BadOutputError, createEngine, defaultPolicy, NeedsHumanError } from "../src/index.ts";
import type { FailureClassifier } from "../src/index.ts";
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

test("a validation error is not retried", async (t) => {
  const { engine, queue, workers } = setup(t);
  let calls = 0;
  const worker = engine.createWorker({
    queue,
    tasks: {
      strict: async () => {
        calls++;
        const err = new Error("email is required");
        err.name = "ZodError";
        throw err;
      },
    },
  });
  workers.push(worker);
  worker.start();

  const { id } = await engine.enqueue("strict", {}, { queue, maxAttempts: 3 });
  const run = await settled(engine, id);

  assert.equal(run.status, "failed");
  assert.equal(calls, 1);
  assert.equal(run.errors[0]?.kind, "bad_input");
  assert.equal(run.errors[0]?.action.type, "fail");
});

test("unusable output is retried with the error as a hint to the handler", async (t) => {
  const { engine, queue, workers } = setup(t);
  const hints: Array<string | undefined> = [];
  const worker = engine.createWorker({
    queue,
    tasks: {
      agent: async (_payload, ctx) => {
        hints.push(ctx.hint);
        if (!ctx.hint) throw new BadOutputError('unknown tool "serch_web"');
        return "used search_web";
      },
    },
  });
  workers.push(worker);
  worker.start();

  const { id } = await engine.enqueue("agent", {}, { queue });
  const run = await settled(engine, id);

  assert.equal(run.status, "completed");
  assert.equal(hints[0], undefined);
  assert.match(hints[1] ?? "", /unknown tool "serch_web"/);
});

test("a run that keeps failing transiently goes dead after maxAttempts", async (t) => {
  const { engine, queue, workers } = setup(t);
  let calls = 0;
  const worker = engine.createWorker({
    queue,
    policy: defaultPolicy({ baseMs: 10 }),
    tasks: {
      down: async () => {
        calls++;
        throw Object.assign(new Error("HTTP 503"), { status: 503 });
      },
    },
  });
  workers.push(worker);
  worker.start();

  const { id } = await engine.enqueue("down", {}, { queue, maxAttempts: 3 });
  const run = await settled(engine, id);

  assert.equal(run.status, "dead");
  assert.equal(calls, 3);
  assert.equal(run.errors.length, 3);
  assert.equal(run.lastError?.attempt, 3);
});

test("a custom classifier fully controls the outcome", async (t) => {
  const { engine, queue, workers } = setup(t);
  // Treat a plain bug as transient, which the rule classifier never would.
  const alwaysTransient: FailureClassifier = { classify: async () => ({ kind: "transient", confidence: 1 }) };
  let calls = 0;
  const worker = engine.createWorker({
    queue,
    classifier: alwaysTransient,
    policy: defaultPolicy({ baseMs: 10 }),
    tasks: {
      buggy: async () => {
        calls++;
        if (calls === 1) throw new TypeError("cannot read properties of undefined");
        return "ok";
      },
    },
  });
  workers.push(worker);
  worker.start();

  const { id } = await engine.enqueue("buggy", {}, { queue });
  const run = await settled(engine, id);

  assert.equal(run.status, "completed");
  assert.equal(run.errors[0]?.kind, "transient");
});

test("a run that needs a human is escalated once, not retried", async (t) => {
  const { engine, queue, workers } = setup(t);
  let calls = 0;
  const worker = engine.createWorker({
    queue,
    tasks: {
      refund: async () => {
        calls++;
        throw new NeedsHumanError("refund of $900 is over the $500 auto-approve limit");
      },
    },
  });
  workers.push(worker);
  worker.start();

  const { id } = await engine.enqueue("refund", {}, { queue, maxAttempts: 3 });
  const run = await settled(engine, id);

  assert.equal(run.status, "failed");
  assert.equal(calls, 1);
  assert.deepEqual(run.errors[0]?.action, { type: "escalate", reason: "refund of $900 is over the $500 auto-approve limit" });
});
