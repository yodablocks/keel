import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

test("an enqueued run is queued and not yet attempted", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  t.after(() => engine.close());

  const { id } = await engine.enqueue("noop", { n: 1 }, { queue: uniqueQueue() });
  const run = await engine.getRun(id);

  assert.equal(run?.status, "queued");
  assert.equal(run?.task, "noop");
  assert.deepEqual(run?.payload, { n: 1 });
  assert.equal(run?.attempt, 0);
});

test("a worker runs the handler and records the result", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();

  const worker = engine.createWorker({
    queue,
    tasks: { double: async (payload) => ({ value: (payload as { n: number }).n * 2 }) },
  });
  worker.start();
  t.after(async () => {
    await worker.stop();
    await engine.close();
  });

  const { id } = await engine.enqueue("double", { n: 21 }, { queue });
  const run = await waitFor(async () => {
    const r = await engine.getRun(id);
    return r?.status === "completed" && r;
  }, 5000, "run to complete");

  assert.deepEqual(run.result, { value: 42 });
  assert.equal(run.attempt, 1);
});
