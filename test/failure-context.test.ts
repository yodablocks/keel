import { test } from "node:test";
import assert from "node:assert/strict";
import { BadOutputError, createEngine } from "../src/index.ts";
import type { FailureClassifier, FailureContext } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

test("the classifier sees which step failed and the output the handler rejected", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const seen: FailureContext[] = [];
  const recording: FailureClassifier = {
    async classify(ctx) {
      seen.push(ctx);
      return { kind: "fatal", confidence: 1 };
    },
  };
  const modelReply = { tool: "search_web", arguments: {} };

  const worker = engine.createWorker({
    queue,
    classifier: recording,
    tasks: {
      agent: async (_payload, ctx) => {
        await ctx.step.run("research", () => "notes");
        await ctx.step.run("choose-tool", () => {
          throw new BadOutputError("Tool call arguments failed validation: missing required property 'query'", {
            output: modelReply,
          });
        });
      },
    },
  });
  t.after(async () => {
    await worker.stop();
    await engine.close();
  });
  worker.start();

  const { id } = await engine.enqueue("agent", {}, { queue });
  await waitFor(async () => (await engine.getRun(id))?.status === "failed", 5000, "run to fail");

  assert.equal(seen[0]?.step, "choose-tool");
  assert.deepEqual(seen[0]?.output, modelReply);
});

test("a failure outside any step has no step name", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const seen: FailureContext[] = [];
  const worker = engine.createWorker({
    queue,
    classifier: { classify: async (ctx) => (seen.push(ctx), { kind: "fatal", confidence: 1 }) },
    tasks: {
      agent: async (_payload, ctx) => {
        await ctx.step.run("research", () => "notes");
        throw new Error("failed between steps");
      },
    },
  });
  t.after(async () => {
    await worker.stop();
    await engine.close();
  });
  worker.start();

  const { id } = await engine.enqueue("agent", {}, { queue });
  await waitFor(async () => (await engine.getRun(id))?.status === "failed", 5000, "run to fail");

  assert.equal(seen[0]?.step, undefined);
});
