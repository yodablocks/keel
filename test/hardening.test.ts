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
