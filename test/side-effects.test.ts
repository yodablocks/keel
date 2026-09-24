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
