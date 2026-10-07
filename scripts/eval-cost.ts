// Scores a recorded eval:classifier result on the cost table in eval-sets/COSTS.md, without calling Jev.
// Usage: node scripts/eval-cost.ts <eval-results/classifier-....json>
import { readFile } from "node:fs/promises";
import type { FailureKind } from "../src/index.ts";
import { printCostReport } from "./eval-costs.ts";

type Pass = { jev: string | null; cascade: FailureKind; cascadeBefore?: FailureKind; cascadeChange?: FailureKind };
interface Row { label: FailureKind | null; rules: FailureKind; withoutContext: Pass; withContext: Pass }

const file = process.argv[2];
if (file === undefined) throw new Error("Usage: node scripts/eval-cost.ts <result file>");
const { summary, rows } = JSON.parse(await readFile(file, "utf8")) as { summary: { source: string }; rows: Row[] };
const KINDS = new Set(["transient", "bad_input", "bad_output", "needs_human", "fatal"]);

// Results from PR #25 recorded the change as "cascade" and the shipped cascade as "cascadeBefore"; later results
// record the shipped cascade as "cascade" and the change as "cascadeChange". Older results have no change.
const shipped = (p: Pass) => p.cascadeBefore ?? p.cascade;
const change = (p: Pass) => p.cascadeChange ?? (p.cascadeBefore !== undefined ? p.cascade : undefined);
const labelled = rows.filter((r): r is Row & { label: FailureKind } => r.label !== null);
const hasChange = labelled.every((r) => change(r.withoutContext) !== undefined);

console.log(`${labelled.length} labelled cases from ${summary.source} (${file})`);
printCostReport(
  labelled.map((r) => ({
    label: r.label,
    passes: [r.withoutContext, r.withContext].map((p) => ({
      rules: r.rules,
      // Jev raw has no verdict where rules decided alone or Jev failed; the shipped cascade's verdict stands in.
      jev: KINDS.has(p.jev ?? "") ? (p.jev as FailureKind) : shipped(p),
      cascade: shipped(p),
      ...(hasChange && { change: change(p)! }),
    })),
  })),
  [
    ["rules", "Rules"],
    ["jev", "Jev raw"],
    ["cascade", "Cascade, as shipped"],
    ...(hasChange ? [["change", "Cascade with the change"] as [string, string]] : []),
  ],
);
