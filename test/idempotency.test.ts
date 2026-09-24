import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEngine } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

function setup(t: import("node:test").TestContext) {
  const engine = createEngine({ connectionString: DATABASE_URL });
  t.after(() => engine.close());
  // Keys are global per task, so tests use unique task names to stay independent.
  return { engine, queue: uniqueQueue(), task: `charge-${randomUUID()}` };
}

test("enqueueing twice with the same key returns the existing run", async (t) => {
  const { engine, queue, task } = setup(t);

  const first = await engine.enqueue(task, { amount: 10 }, { queue, idempotencyKey: "order-1" });
  const second = await engine.enqueue(task, { amount: 10 }, { queue, idempotencyKey: "order-1" });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
});

test("50 concurrent enqueues with the same key create exactly one run", async (t) => {
  const { engine, queue, task } = setup(t);

  const results = await Promise.all(
    Array.from({ length: 50 }, () => engine.enqueue(task, {}, { queue, idempotencyKey: "order-2" })),
  );

  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
});

test("after the key expires, the same key creates a new run", async (t) => {
  const { engine, queue, task } = setup(t);

  const first = await engine.enqueue(task, {}, { queue, idempotencyKey: "order-3", idempotencyTtlMs: 150 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = await engine.enqueue(task, {}, { queue, idempotencyKey: "order-3", idempotencyTtlMs: 150 });

  assert.equal(second.created, true);
  assert.notEqual(second.id, first.id);
  assert.equal((await engine.getRun(first.id))?.status, "queued", "the original run is untouched");
});

test("the same key on different tasks creates separate runs", async (t) => {
  const { engine, queue, task } = setup(t);

  const a = await engine.enqueue(task, {}, { queue, idempotencyKey: "order-4" });
  const b = await engine.enqueue(`${task}-refund`, {}, { queue, idempotencyKey: "order-4" });

  assert.equal(b.created, true);
  assert.notEqual(b.id, a.id);
});

test("a failed run still holds its key", async (t) => {
  const { engine, queue, task } = setup(t);
  const worker = engine.createWorker({
    queue,
    tasks: {
      [task]: async () => {
        throw new TypeError("bug");
      },
    },
  });
  t.after(() => worker.stop());
  worker.start();

  const first = await engine.enqueue(task, {}, { queue, idempotencyKey: "order-5" });
  await waitFor(async () => (await engine.getRun(first.id))?.status === "failed", 5000, "run to fail");
  const second = await engine.enqueue(task, {}, { queue, idempotencyKey: "order-5" });

  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
});
