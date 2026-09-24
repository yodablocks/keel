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

test("1,000 runs across 8 workers each complete exactly once", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const executions = new Map<string, number>();

  const workers = Array.from({ length: 8 }, () =>
    engine.createWorker({
      queue,
      tasks: {
        count: async (payload) => {
          const key = (payload as { key: string }).key;
          executions.set(key, (executions.get(key) ?? 0) + 1);
        },
      },
    }),
  );
  t.after(async () => {
    await Promise.all(workers.map((w) => w.stop()));
    await engine.close();
  });

  const ids: string[] = [];
  for (let i = 0; i < 1000; i++) {
    ids.push((await engine.enqueue("count", { key: `k${i}` }, { queue })).id);
  }
  for (const w of workers) w.start();

  await waitFor(async () => executions.size === 1000, 30_000, "all 1,000 runs to execute");
  const runs = await Promise.all(ids.map((id) => engine.getRun(id)));

  assert.equal(runs.filter((r) => r?.status === "completed").length, 1000);
  assert.deepEqual([...executions.values()].filter((n) => n !== 1), [], "no run executed more than once");
});

test("a handler that outlives its lease keeps the run through heartbeats", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  let executions = 0;

  const slow = async () => {
    executions++;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return "done";
  };
  const workers = [1, 2].map(() => engine.createWorker({ queue, leaseMs: 300, tasks: { slow } }));
  t.after(async () => {
    await Promise.all(workers.map((w) => w.stop()));
    await engine.close();
  });
  for (const w of workers) w.start();

  const { id } = await engine.enqueue("slow", {}, { queue });
  const run = await waitFor(async () => {
    const r = await engine.getRun(id);
    return r?.status === "completed" && r;
  }, 5000, "slow run to complete");

  assert.equal(executions, 1, "run was never reclaimed by the idle worker");
  assert.equal(run.attempt, 1);
});

test("stop waits for the in-flight run to finish and then claims nothing new", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  let started!: () => void;
  const handlerStarted = new Promise<void>((resolve) => (started = resolve));

  const worker = engine.createWorker({
    queue,
    tasks: {
      slow: async () => {
        started();
        await new Promise((resolve) => setTimeout(resolve, 300));
        return "finished";
      },
    },
  });
  t.after(() => engine.close());
  worker.start();

  const first = await engine.enqueue("slow", {}, { queue });
  await handlerStarted;
  await worker.stop();

  assert.equal((await engine.getRun(first.id))?.status, "completed");

  const second = await engine.enqueue("slow", {}, { queue });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await engine.getRun(second.id))?.status, "queued");
});

test("stop with a timeout releases a stuck run so another worker takes it without waiting for the lease", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  let started!: () => void;
  const handlerStarted = new Promise<void>((resolve) => (started = resolve));

  const stuck = engine.createWorker({
    queue,
    leaseMs: 60_000,
    tasks: {
      work: async () => {
        started();
        await new Promise(() => {});
      },
    },
  });
  const other = engine.createWorker({ queue, leaseMs: 60_000, tasks: { work: async () => "taken over" } });
  t.after(async () => {
    await other.stop();
    await engine.close();
  });
  stuck.start();

  const { id } = await engine.enqueue("work", {}, { queue });
  await handlerStarted;
  await stuck.stop({ timeoutMs: 200 });
  other.start();

  const run = await waitFor(async () => {
    const r = await engine.getRun(id);
    return r?.status === "completed" && r;
  }, 3000, "released run to be taken over");
  assert.equal(run.result, "taken over");
});
