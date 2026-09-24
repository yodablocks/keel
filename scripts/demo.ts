// keel agent demo. One run, two worker processes, five moments:
//   1. the model hallucinates a tool name and the classifier sends a corrective hint
//   2. worker A is SIGKILLed mid-draft and worker B resumes from stored steps
//   3. the email API rate-limits and the run backs off
//   4. the run goes over budget and escalates to a person
//   5. the reviewer raises the budget and approves, and the run completes
// Usage: pnpm demo (real Jev, needs TYPESAFE_API_KEY) or pnpm demo --offline
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { createEngine, migrate } from "../src/index.ts";
import { TASK } from "./demo/agent.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://keel:keel@localhost:5433/keel";
const offline = process.argv.includes("--offline") || !process.env.TYPESAFE_API_KEY;
const queue = `demo-${randomUUID().slice(0, 8)}`;
const workerScript = fileURLToPath(new URL("./demo/worker.ts", import.meta.url));
const say = (line: string) => process.stdout.write(`${line}\n`);

await migrate(DATABASE_URL);
const engine = createEngine({ connectionString: DATABASE_URL });
const workers: ChildProcess[] = [];

function startWorker(name: string, onLine: (line: string) => void = () => {}): ChildProcess {
  const child = spawn(process.execPath, [workerScript], {
    env: { ...process.env, KEEL_DEMO_WORKER: name, KEEL_DEMO_QUEUE: queue, KEEL_DEMO_OFFLINE: offline ? "1" : "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  createInterface({ input: child.stdout! }).on("line", (line) => {
    say(line);
    onLine(line);
  });
  workers.push(child);
  return child;
}

say(`keel demo: queue ${queue}, classifier: ${offline ? "offline stand-in (set TYPESAFE_API_KEY for real Jev)" : "Jev (jev-latest)"}`);
const { id } = await engine.enqueue(TASK, { topic: "durable execution" }, { queue, budget: { usd: 0.125 }, maxAttempts: 6 });
say(`[demo] enqueued run ${id} with a $0.125 budget`);

let killedA = false;
const workerA = startWorker("A", (line) => {
  if (!killedA && line.includes("calling model for draft")) {
    killedA = true;
    say("[demo] SIGKILL worker A (mid-draft, no cleanup)");
    workerA.kill("SIGKILL");
    say("[demo] starting worker B; it can take the run once A's 1.5s lease expires");
    startWorker("B");
  }
});

let lastStatus = "";
let approved = false;
const deadline = Date.now() + 45_000;
let exitCode = 1;
while (Date.now() < deadline) {
  const run = await engine.getRun(id);
  if (run && run.status !== lastStatus) {
    lastStatus = run.status;
    say(`[run] ${run.status} (attempt ${run.attempt}, spent $${run.usage.usd.toFixed(2)})`);
  }
  if (run?.status === "waiting" && !approved) {
    const pending = (await engine.listPendingApprovals()).find((a) => a.runId === id);
    if (pending) {
      say(`[reviewer] pending approval "${pending.name}": ${pending.prompt}`);
      await engine.setRunBudget(id, { usd: 0.25 });
      await engine.resolveApproval(id, pending.name, { approved: true, by: "demo-reviewer", comment: "Budget raised to $0.25, finish the run." });
      approved = true;
      say("[reviewer] reviewer raised the budget and approved");
    }
  }
  if (run?.status === "completed") {
    say(`[demo] run completed after ${run.attempt} attempts, spent $${run.usage.usd.toFixed(2)}`);
    say(`[demo] result: ${JSON.stringify(run.result)}`);
    say("[demo] error history:");
    for (const e of run.errors) say(`  attempt ${e.attempt}: ${e.name}: ${e.message} -> ${e.kind}, ${e.action.type}`);
    exitCode = 0;
    break;
  }
  if (run && ["failed", "dead"].includes(run.status)) {
    say(`[demo] run ended as ${run.status}: ${JSON.stringify(run.lastError)}`);
    break;
  }
  await sleep(100);
}
if (exitCode !== 0 && Date.now() >= deadline) say("[demo] timed out");

for (const w of workers) if (w.exitCode === null && w.signalCode === null) w.kill("SIGTERM");
await Promise.all(workers.map((w) => (w.exitCode === null && w.signalCode === null ? new Promise((r) => w.once("exit", r)) : null)));
await engine.close();
process.exit(exitCode);
