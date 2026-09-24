import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

async function status(engine: ReturnType<typeof createEngine>, id: string, want: string, timeoutMs = 5000) {
  return waitFor(async () => {
    const r = await engine.getRun(id);
    return r?.status === want && r;
  }, timeoutMs, `run to be ${want}`);
}

test("a run released on its final attempt goes dead instead of getting an extra execution", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  t.after(() => engine.close());
  let entered!: () => void;
  const running = new Promise<void>((resolve) => (entered = resolve));

  const worker = engine.createWorker({
    queue,
    tasks: {
      stuck: async () => {
        entered();
        await new Promise(() => {});
      },
    },
  });
  worker.start();

  const { id } = await engine.enqueue("stuck", {}, { queue, maxAttempts: 1 });
  await running;
  await worker.stop({ timeoutMs: 50 });

  const run = await engine.getRun(id);
  assert.equal(run?.status, "dead");
  assert.equal(run?.errors[0]?.name, "Released");
});

for (const [label, policy] of [
  ["throws", () => { throw new Error("policy bug"); }],
  ["returns an invalid delay", () => ({ type: "retry" as const, delayMs: Number.NaN })],
] as const) {
  test(`a policy that ${label} fails the run at once with the policy error recorded`, async (t) => {
    const engine = createEngine({ connectionString: DATABASE_URL });
    const queue = uniqueQueue();
    const worker = engine.createWorker({
      queue,
      leaseMs: 60_000,
      policy,
      tasks: {
        broken: async () => {
          throw new Error("handler failure");
        },
      },
    });
    t.after(async () => {
      await worker.stop();
      await engine.close();
    });
    worker.start();

    const { id } = await engine.enqueue("broken", {}, { queue });
    const run = await status(engine, id, "failed", 2000);

    assert.equal(run.errors[0]?.message, "handler failure");
    assert.equal(run.errors[0]?.action.type, "fail");
    assert.match((run.errors[0]?.action as { reason: string }).reason, /policy/i);
  });
}

test("purge deletes finished runs older than the cutoff and leaves unfinished runs replayable", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  let researched = 0;
  const worker = engine.createWorker({
    queue,
    tasks: {
      ok: async () => "done",
      bad: async () => {
        throw new TypeError("bug");
      },
      slow: async (_payload, ctx) => {
        await ctx.step.run("research", () => researched++);
        await ctx.wait.forEvent("go", `purge-test-${queue}`, { timeoutMs: 60_000 });
        return "resumed";
      },
    },
  });
  t.after(async () => {
    await worker.stop();
    await engine.close();
  });
  worker.start();

  const oldDone = await engine.enqueue("ok", {}, { queue, idempotencyKey: `old-done-${queue}` });
  const oldFailed = await engine.enqueue("bad", {}, { queue });
  const waiting = await engine.enqueue("slow", {}, { queue });
  await status(engine, oldDone.id, "completed");
  await status(engine, oldFailed.id, "failed");
  await status(engine, waiting.id, "waiting");

  await new Promise((resolve) => setTimeout(resolve, 50));
  const cutoff = new Date();
  const recent = await engine.enqueue("ok", {}, { queue });
  await status(engine, recent.id, "completed");

  const purged = await engine.purge({ olderThan: cutoff, queue });

  assert.equal(purged.runs, 2);
  assert.equal(await engine.getRun(oldDone.id), undefined);
  assert.equal(await engine.getRun(oldFailed.id), undefined);
  assert.equal((await engine.getRun(recent.id))?.status, "completed");
  assert.equal((await engine.enqueue("ok", {}, { queue, idempotencyKey: `old-done-${queue}` })).created, true, "the purged run's key is free again");

  await engine.sendEvent(`purge-test-${queue}`);
  const resumed = await status(engine, waiting.id, "completed");
  assert.equal(resumed.result, "resumed");
  assert.equal(researched, 1, "the waiting run's stored step survived the purge");
});

test("a worker with retention purges its own queue periodically", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const worker = engine.createWorker({ queue, retention: { keepMs: 0, everyMs: 100 }, tasks: { ok: async () => "done" } });
  t.after(async () => {
    await worker.stop();
    await engine.close();
  });
  worker.start();

  const { id } = await engine.enqueue("ok", {}, { queue });
  await waitFor(async () => (await engine.getRun(id)) === undefined, 3000, "finished run to be purged");
});
