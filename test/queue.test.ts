import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";

test("an enqueued run is queued and not yet attempted", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  t.after(() => engine.close());

  const { id } = await engine.enqueue("noop", { n: 1 }, { queue: uniqueQueue() });
  const run = await engine.getRun(id);

  assert.equal(run?.status, "queued");
  assert.equal(run?.task, "noop");
  assert.deepEqual(run?.payload, { n: 1 });
  assert.equal(run?.attempt, 0);
});
