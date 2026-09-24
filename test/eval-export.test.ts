import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine, RuleClassifier } from "../src/index.ts";
import { exportFailures, loadCases } from "../scripts/eval-cases.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

test("real failures export to a labelling file that the eval loads back with their signals intact", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const worker = engine.createWorker({
    queue,
    tasks: {
      agent: async (_payload, ctx) => {
        await ctx.step.run("send", () => {
          throw Object.assign(new Error("rate limited"), { status: 429, output: { retryAfterSeconds: 30 } });
        });
      },
    },
  });
  t.after(async () => {
    await worker.stop();
    await engine.close();
  });
  worker.start();
  const { id } = await engine.enqueue("agent", {}, { queue, maxAttempts: 1 });
  await waitFor(async () => (await engine.getRun(id))?.status === "dead", 5000, "run to go dead");

  const exported = await exportFailures(DATABASE_URL, { queue });
  assert.equal(exported.length, 1);
  assert.equal(exported[0]!.label, null, "exported cases wait for a person to label them");
  assert.equal(exported[0]!.recordedKind, "transient");

  const dir = await mkdtemp(join(tmpdir(), "keel-eval-"));
  const file = join(dir, "cases.json");
  await writeFile(file, JSON.stringify(exported, null, 2));
  const unlabelled = await loadCases(file);
  assert.deepEqual([unlabelled.cases.length, unlabelled.skipped], [0, 1], "unlabelled cases are skipped, not guessed");

  const labelled = JSON.parse(await readFile(file, "utf8"));
  labelled[0].label = "transient";
  await writeFile(file, JSON.stringify(labelled));
  const { cases } = await loadCases(file);

  assert.equal(cases[0]!.step, "send");
  assert.deepEqual(cases[0]!.output, { retryAfterSeconds: 30 });
  const verdict = await new RuleClassifier().classify({ error: cases[0]!.error, task: cases[0]!.task, payload: {}, attempt: 1, maxAttempts: 3 });
  assert.equal(verdict.kind, "transient", "the status survives the round trip, so rules see what they saw live");
});
