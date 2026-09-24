import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createEngine } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

const hangingWorker = fileURLToPath(new URL("./fixtures/hanging-worker.ts", import.meta.url));

test("a run from a killed worker is picked up by another worker after the lease expires", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const leaseMs = 500;

  const { id } = await engine.enqueue("work", {}, { queue });

  const child = spawn(process.execPath, [hangingWorker], {
    env: { ...process.env, KEEL_QUEUE: queue, KEEL_LEASE_MS: String(leaseMs) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [line] = await once(child.stdout, "data");
  assert.equal(String(line).trim(), "started");

  child.kill("SIGKILL");
  await once(child, "exit");

  const survivor = engine.createWorker({ queue, leaseMs, tasks: { work: async () => "recovered" } });
  t.after(async () => {
    await survivor.stop();
    await engine.close();
  });
  survivor.start();

  const run = await waitFor(async () => {
    const r = await engine.getRun(id);
    return r?.status === "completed" && r;
  }, 5000, "run to be recovered");

  assert.equal(run.result, "recovered");
  assert.equal(run.attempt, 2);
  assert.equal(run.errors[0]?.name, "LeaseExpired", "the lost attempt is recorded");
});

test("a run whose final attempt crashed its worker goes dead instead of running again", async (t) => {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const leaseMs = 500;

  const { id } = await engine.enqueue("work", {}, { queue, maxAttempts: 1 });

  const child = spawn(process.execPath, [hangingWorker], {
    env: { ...process.env, KEEL_QUEUE: queue, KEEL_LEASE_MS: String(leaseMs) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");

  let calls = 0;
  const survivor = engine.createWorker({ queue, leaseMs, tasks: { work: async () => void calls++ } });
  t.after(async () => {
    await survivor.stop();
    await engine.close();
  });
  survivor.start();

  const run = await waitFor(async () => {
    const r = await engine.getRun(id);
    return r?.status === "dead" && r;
  }, 5000, "run to go dead");

  assert.equal(calls, 0);
  assert.equal(run.lastError?.name, "LeaseExpired");
});
