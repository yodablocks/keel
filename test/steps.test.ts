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

async function settled(engine: ReturnType<typeof createEngine>, id: string) {
  return waitFor(async () => {
    const r = await engine.getRun(id);
    return r && ["completed", "failed", "dead"].includes(r.status) && r;
  }, 5000, "run to settle");
}

test("completed steps are not re-executed when the run retries", async (t) => {
  const executions = { plan: 0, draft: 0, send: 0 };
  const { engine, queue } = setup(t, {
    agent: async (_payload, ctx) => {
      const plan = await ctx.step.run("plan", async () => {
        executions.plan++;
        return { outline: ["intro", "body"], at: executions.plan };
      });
      const draft = await ctx.step.run("draft", async () => {
        executions.draft++;
        return `draft of ${plan.outline.join("+")} #${plan.at}`;
      });
      return ctx.step.run("send", async () => {
        executions.send++;
        if (executions.send === 1) throw Object.assign(new Error("HTTP 503"), { status: 503 });
        return `sent: ${draft}`;
      });
    },
  });

  const { id } = await engine.enqueue("agent", {}, { queue });
  const run = await settled(engine, id);

  assert.equal(run.status, "completed");
  assert.equal(run.attempt, 2);
  assert.deepEqual(executions, { plan: 1, draft: 1, send: 2 });
  assert.equal(run.result, "sent: draft of intro+body #1");
});
