import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEngine } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";

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
