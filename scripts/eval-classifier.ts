// Compares RuleClassifier, raw Jev, and the JevClassifier cascade on the labelled cases.
// Needs @typesafe-ai/sdk and TYPESAFE_API_KEY. Makes one Jev call per case.
import { writeFile, mkdir } from "node:fs/promises";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { JevClassifier, RuleClassifier } from "../src/index.ts";
import type { FailureContext, FailureKind, SystemOneClient } from "../src/index.ts";
import { FAILURE_CASES } from "./failure-cases.ts";

const sdk = new TypeSafeClient();
const rawAnswers: Array<{ choice?: string; confidence?: number }> = [];
let inputTokens = 0;
let outputTokens = 0;

// Records Jev's raw answer and token usage for every call the cascade makes.
const recording: SystemOneClient = {
  async systemOne(request) {
    const response = await sdk.systemOne(request as Parameters<typeof sdk.systemOne>[0]);
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    const answer = (response.answers as Record<string, { choice?: string; confidence?: number }>).failure_kind ?? {};
    rawAnswers.push(answer);
    return response as Awaited<ReturnType<SystemOneClient["systemOne"]>>;
  },
};

const rules = new RuleClassifier();
const cascade = new JevClassifier({ client: recording });

interface Row {
  task: string;
  message: string;
  label: FailureKind;
  rules: FailureKind;
  jev: string | null;
  jevConfidence: number | null;
  cascade: FailureKind;
}

const rows: Row[] = [];
for (const c of FAILURE_CASES) {
  const ctx: FailureContext = { error: c.error, task: c.task, payload: {}, attempt: 1, maxAttempts: 3 };
  const byRules = await rules.classify(ctx);
  const before = rawAnswers.length;
  const byCascade = await cascade.classify(ctx);
  const raw = rawAnswers.length > before ? rawAnswers[rawAnswers.length - 1]! : undefined;
  rows.push({
    task: c.task,
    message: c.error instanceof Error ? c.error.message : String(c.error),
    label: c.label,
    rules: byRules.kind,
    jev: raw?.choice ?? null,
    jevConfidence: raw?.confidence ?? null,
    cascade: byCascade.kind,
  });
}

const n = rows.length;
const accuracy = (pick: (r: Row) => string | null) => rows.filter((r) => pick(r) === r.label).length;
const summary = {
  cases: n,
  rules: accuracy((r) => r.rules),
  jevRaw: accuracy((r) => r.jev),
  cascade: accuracy((r) => r.cascade),
  jevCalls: rawAnswers.length,
  fellBackToRules: rows.filter((r) => r.jev !== null && r.cascade !== r.jev).length,
  tokens: { input: inputTokens, output: outputTokens },
};

console.log(`Cases: ${n}`);
console.log(`Rules:          ${summary.rules}/${n} (${Math.round((summary.rules / n) * 100)}%)`);
console.log(`Jev (raw):      ${summary.jevRaw}/${n} (${Math.round((summary.jevRaw / n) * 100)}%)`);
console.log(`Cascade:        ${summary.cascade}/${n} (${Math.round((summary.cascade / n) * 100)}%)`);
console.log(`Jev calls: ${summary.jevCalls}, fell back to rules: ${summary.fellBackToRules}, tokens: ${inputTokens} in / ${outputTokens} out`);
console.log("\nMisclassified by the cascade:");
for (const r of rows.filter((r) => r.cascade !== r.label)) {
  console.log(`  [${r.label} -> ${r.cascade}] (jev: ${r.jev} @ ${r.jevConfidence?.toFixed(2)}) ${r.message}`);
}

await mkdir("eval-results", { recursive: true });
const file = `eval-results/classifier-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.json`;
await writeFile(file, JSON.stringify({ model: "jev-latest", summary, rows }, null, 2));
console.log(`\nWrote ${file}`);
