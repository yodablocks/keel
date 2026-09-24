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

async function status(engine: ReturnType<typeof createEngine>, id: string, want: string, timeoutMs = 5000) {
  return waitFor(async () => {
    const r = await engine.getRun(id);
    return r?.status === want && r;
  }, timeoutMs, `run to be ${want}`);
}

test("a step's idempotency key is the same on every attempt and unique per step", async (t) => {
  const keys: string[] = [];
  let attempts = 0;
  const { engine, queue } = setup(t, {
    pay: async (_payload, ctx) => {
      attempts++;
      await ctx.step.run("charge", ({ idempotencyKey }) => {
        keys.push(idempotencyKey);
        if (attempts === 1) throw Object.assign(new Error("HTTP 503"), { status: 503 });
        return "charged";
      });
      await ctx.step.run("receipt", ({ idempotencyKey }) => void keys.push(idempotencyKey));
    },
  });

  const { id } = await engine.enqueue("pay", {}, { queue });
  await status(engine, id, "completed");

  assert.deepEqual(keys, [`keel:${id}:charge`, `keel:${id}:charge`, `keel:${id}:receipt`]);
});

function abortedWithin(signal: AbortSignal, ms: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

test("ctx.signal aborts when stop releases the run", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  let signal!: AbortSignal;
  let entered!: () => void;
  const running = new Promise<void>((resolve) => (entered = resolve));

  const worker = engine.createWorker({
    queue,
    tasks: {
      slow: async (_payload, ctx) => {
        signal = ctx.signal;
        entered();
        await new Promise(() => {});
      },
    },
  });
  t.after(() => engine.close());
  worker.start();

  await engine.enqueue("slow", {}, { queue });
  await running;
  assert.equal(signal.aborted, false);
  await worker.stop({ timeoutMs: 50 });

  assert.equal(await abortedWithin(signal, 1000), true);
});

test("ctx.signal aborts when a heartbeat finds another worker took the run", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const signals: AbortSignal[] = [];
  const hang = async (_payload: unknown, ctx: import("../src/index.ts").TaskContext) => {
    signals.push(ctx.signal);
    await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
  };

  // The lease expires before the first heartbeat, so the second worker takes the run over.
  const slow = engine.createWorker({ queue, leaseMs: 200, heartbeatMs: 500, tasks: { hang } });
  const other = engine.createWorker({ queue, leaseMs: 60_000, tasks: { hang } });
  t.after(async () => {
    await other.stop({ timeoutMs: 50 });
    await slow.stop({ timeoutMs: 50 });
    await engine.close();
  });
  slow.start();
  await engine.enqueue("hang", {}, { queue });
  await waitFor(async () => signals.length === 1, 5000, "first worker to start the run");
  other.start();
  await waitFor(async () => signals.length === 2, 5000, "second worker to take the run over");

  assert.equal(await abortedWithin(signals[0]!, 2000), true, "the first worker learns it lost the run");
  assert.equal(signals[1]!.aborted, false);
});
