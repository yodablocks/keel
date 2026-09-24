// Compares RuleClassifier with the JevClassifier cascade, with and without step context (M11).
// Needs @typesafe-ai/sdk and TYPESAFE_API_KEY. Makes up to two Jev calls per case.
// Usage: pnpm eval:classifier                  (the synthetic fixture in scripts/failure-cases.ts)
//        pnpm eval:classifier --cases file.json (a labelled file from pnpm eval:export)
import { writeFile, mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { JevClassifier, RuleClassifier } from "../src/index.ts";
import type { FailureContext, FailureKind, SystemOneClient } from "../src/index.ts";
import { FAILURE_CASES } from "./failure-cases.ts";
import { loadCases } from "./eval-cases.ts";
import type { FailureCase } from "./eval-cases.ts";

const { values } = parseArgs({ options: { cases: { type: "string" } } });
let cases: FailureCase[] = FAILURE_CASES;
let source = "scripts/failure-cases.ts (synthetic)";
if (values.cases !== undefined) {
  const loaded = await loadCases(values.cases);
  cases = loaded.cases;
  source = values.cases;
  if (loaded.skipped > 0) console.log(`Skipped ${loaded.skipped} unlabelled cases in ${values.cases}.`);
}
if (cases.length === 0) {
  console.log("No labelled cases to evaluate.");
  process.exit(0);
}

const sdk = new TypeSafeClient();
let lastAnswer: { choice?: string; confidence?: number } | undefined;
let calls = 0;
// The concrete model behind "jev-latest" (for example jev-1.13.0), so runs on different days are comparable.
const models = new Set<string>();
let inputTokens = 0;
let outputTokens = 0;

// Records Jev's raw answer and token usage for every call the cascade makes.
const recording: SystemOneClient = {
  async systemOne(request) {
    const response = await sdk.systemOne(request as Parameters<typeof sdk.systemOne>[0]);
    calls++;
    models.add(response.model);
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    lastAnswer = (response.answers.failure_kind ?? {}) as { choice?: string; confidence?: number };
    return response;
  },
};

const MIN_CONFIDENCE = 0.5;
const rules = new RuleClassifier();
const cascade = new JevClassifier({ client: recording, minConfidence: MIN_CONFIDENCE });

interface Variant {
  jev: string | null;
  jevConfidence: number | null;
  cascade: FailureKind;
}

async function run(ctx: FailureContext): Promise<Variant> {
  lastAnswer = undefined;
  const verdict = await cascade.classify(ctx);
  // Set by the recording client during classify; TypeScript cannot see that assignment.
  const answer = lastAnswer as { choice?: string; confidence?: number } | undefined;
  return { jev: answer?.choice ?? null, jevConfidence: answer?.confidence ?? null, cascade: verdict.kind };
}

interface Row {
  task: string;
  step: string | null;
  message: string;
  label: FailureKind;
  rules: FailureKind;
  withoutContext: Variant;
  withContext: Variant;
}

const rows: Row[] = [];
for (const c of cases) {
  const base: FailureContext = { error: c.error, task: c.task, payload: {}, attempt: 1, maxAttempts: 3 };
  const withContext: FailureContext = {
    ...base,
    ...(c.step !== undefined && { step: c.step }),
    ...(c.output !== undefined && { output: c.output }),
  };
  rows.push({
    task: c.task,
    step: c.step ?? null,
    message: c.error instanceof Error ? c.error.message : String(c.error),
    label: c.label,
    rules: (await rules.classify(base)).kind,
    withoutContext: await run(base),
    withContext: await run(withContext),
  });
}

const n = rows.length;
const correct = (pick: (r: Row) => string | null) => rows.filter((r) => pick(r) === r.label).length;
const below = (pick: (r: Row) => number | null) => rows.filter((r) => (pick(r) ?? 1) < MIN_CONFIDENCE).length;
const summary = {
  source,
  cases: n,
  rules: correct((r) => r.rules),
  withoutContext: { jevRaw: correct((r) => r.withoutContext.jev), cascade: correct((r) => r.withoutContext.cascade), belowThreshold: below((r) => r.withoutContext.jevConfidence) },
  withContext: { jevRaw: correct((r) => r.withContext.jev), cascade: correct((r) => r.withContext.cascade), belowThreshold: below((r) => r.withContext.jevConfidence) },
  jevCalls: calls,
  models: [...models],
  tokens: { input: inputTokens, output: outputTokens },
};

const pct = (k: number) => `${k}/${n} (${Math.round((k / n) * 100)}%)`;
console.log(`Cases: ${n} from ${source}`);
console.log(`Rules:                          ${pct(summary.rules)}`);
console.log(`Jev raw, without step context:  ${pct(summary.withoutContext.jevRaw)}`);
console.log(`Cascade, without step context:  ${pct(summary.withoutContext.cascade)}  (${summary.withoutContext.belowThreshold} below ${MIN_CONFIDENCE})`);
console.log(`Jev raw, with step context:     ${pct(summary.withContext.jevRaw)}`);
console.log(`Cascade, with step context:     ${pct(summary.withContext.cascade)}  (${summary.withContext.belowThreshold} below ${MIN_CONFIDENCE})`);
console.log(`Jev calls: ${calls} (model ${[...models].join(", ")}), tokens: ${inputTokens} in / ${outputTokens} out`);
console.log("\nMisclassified by the cascade with step context:");
for (const r of rows.filter((r) => r.withContext.cascade !== r.label)) {
  console.log(`  [${r.label} -> ${r.withContext.cascade}] (jev: ${r.withContext.jev} @ ${r.withContext.jevConfidence?.toFixed(2)}) ${r.message}`);
}
console.log("\nChanged by step context:");
for (const r of rows.filter((r) => r.withContext.cascade !== r.withoutContext.cascade)) {
  const mark = r.withContext.cascade === r.label ? "fixed" : r.withoutContext.cascade === r.label ? "broke" : "changed";
  console.log(`  ${mark}: [${r.label}] ${r.withoutContext.cascade} -> ${r.withContext.cascade} (step ${r.step}) ${r.message}`);
}

await mkdir("eval-results", { recursive: true });
const file = `eval-results/classifier-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.json`;
await writeFile(file, JSON.stringify({ model: [...models].join(", "), summary, rows }, null, 2));
console.log(`\nWrote ${file}`);
