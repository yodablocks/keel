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
