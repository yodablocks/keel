// One demo worker process. The orchestrator starts two of these and kills the first mid-run.
import { createEngine, defaultPolicy, JevClassifier, RuleClassifier } from "../../src/index.ts";
import type { FailureClassifier } from "../../src/index.ts";
import { agent, TASK } from "./agent.ts";

const name = process.env.KEEL_DEMO_WORKER ?? "?";
const offline = process.env.KEEL_DEMO_OFFLINE === "1";
const log = (line: string) => process.stdout.write(`[worker ${name}] ${line}\n`);

// Offline stand-in for Jev: rules, plus the one message-only case the demo needs.
const offlineStandIn: FailureClassifier = {
  async classify(ctx) {
    const message = ctx.error instanceof Error ? ctx.error.message : String(ctx.error);
    if (/not in the provided tool list/.test(message)) return { kind: "bad_output", confidence: 0.9 };
    return new RuleClassifier().classify(ctx);
  },
};

async function makeClassifier(): Promise<FailureClassifier> {
  if (offline) return offlineStandIn;
  const { TypeSafeClient } = await import("@typesafe-ai/sdk");
  return new JevClassifier({ client: new TypeSafeClient() });
}

const base = await makeClassifier();
const classifier: FailureClassifier = {
  async classify(ctx) {
    const verdict = await base.classify(ctx);
    const message = ctx.error instanceof Error ? ctx.error.message : String(ctx.error);
    log(`attempt ${ctx.attempt} failed: "${message}"`);
    log(`  classified as ${verdict.kind} (confidence ${verdict.confidence.toFixed(2)})`);
    return verdict;
  },
};
const basePolicy = defaultPolicy({ baseMs: 800, maxMs: 5000 });

const engine = createEngine({ connectionString: process.env.DATABASE_URL ?? "postgres://keel:keel@localhost:5433/keel" });
const worker = engine.createWorker({
  queue: process.env.KEEL_DEMO_QUEUE!,
  leaseMs: 1500,
  classifier,
  policy: (verdict, ctx) => {
    const action = basePolicy(verdict, ctx);
    const detail =
      action.type === "retry" ? `, backoff ${action.delayMs}ms`
      : action.type === "retry_modified" ? `, hint: ${action.hint}`
      : "reason" in action ? `, reason: ${action.reason}`
      : "";
    log(`  action: ${action.type}${detail}`);
    return action;
  },
  tasks: { [TASK]: agent(log, Number(process.env.KEEL_DEMO_DRAFT_MS ?? 1500)) },
});

process.on("SIGTERM", async () => {
  await worker.stop({ timeoutMs: 1000 });
  await engine.close();
  process.exit(0);
});

log(`started (${offline ? "offline stand-in classifier" : "Jev classifier, jev-latest"})`);
worker.start();
