import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

test("listRuns returns a queue's runs newest first, filtered by status, task and tenant", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  t.after(() => engine.close());

  const a = await engine.enqueue("research", {}, { queue, tenant: "acme" });
  const b = await engine.enqueue("send", {}, { queue, tenant: "acme" });
  const c = await engine.enqueue("research", {}, { queue, tenant: "globex" });

  assert.deepEqual((await engine.listRuns({ queue })).map((r) => r.id), [c.id, b.id, a.id]);
  assert.deepEqual((await engine.listRuns({ queue, task: "research" })).map((r) => r.id), [c.id, a.id]);
  assert.deepEqual((await engine.listRuns({ queue, tenant: "acme" })).map((r) => r.id), [b.id, a.id]);
  assert.deepEqual((await engine.listRuns({ queue, status: "completed" })).map((r) => r.id), []);
  assert.deepEqual((await engine.listRuns({ queue, limit: 1 })).map((r) => r.id), [c.id]);
});

test("getRunDetail returns the run with its steps and waits", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const worker = engine.createWorker({
    queue,
    tasks: {
      agent: async (_payload, ctx) => {
        await ctx.step.run("research", () => ({ notes: 2 }), { usage: () => ({ usd: 0.04, tokens: 1800 }) });
        await ctx.approval.request("ship-it", { prompt: "Ship the draft?" });
      },
    },
  });
  t.after(async () => {
    await worker.stop();
    await engine.close();
  });
  worker.start();

  const { id } = await engine.enqueue("agent", {}, { queue });
  await waitFor(async () => (await engine.getRun(id))?.status === "waiting", 5000, "run to wait for approval");
  const detail = await engine.getRunDetail(id);

  assert.equal(detail?.run.id, id);
  assert.deepEqual(detail?.steps.map((s) => [s.name, s.result, s.usd, s.tokens, s.attempt]), [["research", { notes: 2 }, 0.04, 1800, 1]]);
  assert.deepEqual(detail?.waits.map((w) => [w.name, w.kind, w.prompt, w.status]), [["ship-it", "approval", "Ship the draft?", "pending"]]);
  assert.equal(await engine.getRunDetail("00000000-0000-0000-0000-000000000000"), undefined);
});
