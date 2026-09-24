import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createEngine } from "../src/index.ts";
import type { TaskHandler } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";

function setup(t: import("node:test").TestContext, tasks: Record<string, TaskHandler>) {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  // Never started: every test drives it with runOnce, like a cron job or a serverless function would.
  const worker = engine.createWorker({ queue, tasks });
  t.after(() => engine.close());
  return { engine, queue, worker };
}

test("a run with steps and a wait completes across several runOnce calls with no long-lived worker", async (t) => {
  const executed: string[] = [];
  const { engine, queue, worker } = setup(t, {
    agent: async (_payload, ctx) => {
      await ctx.step.run("research", () => executed.push("research"));
      await ctx.step.run("draft", () => executed.push("draft"));
      await ctx.wait.for("cool-off", 300);
      await ctx.step.run("send", () => executed.push("send"));
      return "sent";
    },
  });
  const { id } = await engine.enqueue("agent", {}, { queue });

  const first = await worker.runOnce();
  assert.deepEqual([first.claimed, first.suspended], [1, 1]);
  assert.equal((await engine.getRun(id))?.status, "waiting");

  const tooEarly = await worker.runOnce();
  assert.equal(tooEarly.claimed, 0, "nothing is due while the wait is pending");

  await sleep(350);
  const last = await worker.runOnce();
  assert.equal(last.completed, 1);

  const run = await engine.getRun(id);
  assert.equal(run?.result, "sent");
  assert.deepEqual(executed, ["research", "draft", "send"], "no step ran twice");
});

test("a deadline inside a step yields the run without using up an attempt, and the next call resumes it", async (t) => {
  const executed: string[] = [];
  const { engine, queue, worker } = setup(t, {
    agent: async (_payload, ctx) => {
      await ctx.step.run("fetch", () => executed.push("fetch"));
      await ctx.step.run("summarize", async () => {
        executed.push("summarize");
        if (executed.filter((s) => s === "summarize").length === 1) await sleep(1000); // too slow the first time
      });
      await ctx.step.run("send", () => executed.push("send"));
      return "sent";
    },
  });
  const { id } = await engine.enqueue("agent", {}, { queue, maxAttempts: 1 });

  const first = await worker.runOnce({ deadlineMs: 400, releaseMarginMs: 100 });
  assert.deepEqual([first.claimed, first.yielded], [1, 1]);
  const paused = await engine.getRun(id);
  assert.equal(paused?.status, "queued");
  assert.equal(paused?.attempt, 0, "the yield did not use up the only attempt");

  const second = await worker.runOnce();
  assert.equal(second.completed, 1);
  const run = await engine.getRun(id);
  assert.equal(run?.status, "completed");
  assert.equal(run?.attempt, 1);
  assert.deepEqual(executed, ["fetch", "summarize", "summarize", "send"], "fetch was not repeated; the interrupted step re-ran");
});

test("a step longer than any deadline uses up attempts instead of yielding forever", async (t) => {
  const { engine, queue, worker } = setup(t, {
    slow: async (_payload, ctx) => {
      await ctx.step.run("too-long", () => sleep(1000));
    },
  });
  const { id } = await engine.enqueue("slow", {}, { queue, maxAttempts: 2 });

  for (let i = 0; i < 2; i++) await worker.runOnce({ deadlineMs: 300, releaseMarginMs: 100 });

  const run = await engine.getRun(id);
  assert.equal(run?.status, "dead");
  assert.deepEqual(run?.errors.map((e) => e.name), ["Released", "Released"]);
});

test("runOnce claims at most maxRuns runs", async (t) => {
  const { engine, queue, worker } = setup(t, { noop: async () => "done" });
  for (let i = 0; i < 5; i++) await engine.enqueue("noop", {}, { queue });

  const result = await worker.runOnce({ maxRuns: 2 });

  assert.deepEqual([result.claimed, result.completed], [2, 2]);
  assert.equal((await engine.listRuns({ queue, status: "queued" })).length, 3);
});

test("runOnce refuses to run on a started worker", async (t) => {
  const { worker } = setup(t, {});
  worker.start();
  t.after(() => worker.stop());
  await assert.rejects(worker.runOnce(), /cannot be used while the worker is started/);
});
