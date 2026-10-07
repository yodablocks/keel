// What a wrong verdict costs, by the action keel's default policy takes for it. Reasons for each number are in
// eval-sets/COSTS.md; change them there and here together, and only before a set is scored.
import type { FailureKind } from "../src/index.ts";

export type Action = "retry" | "retry_modified" | "fail" | "escalate";

export const ACTION: Record<FailureKind, Action> = {
  transient: "retry",
  bad_output: "retry_modified",
  bad_input: "fail",
  fatal: "fail",
  needs_human: "escalate",
  over_budget: "escalate",
};

export interface CostUnits {
  wastedAttempts: number;
  personTime: number;
  lostRun: number;
  actedWithoutApproval: number;
}

export const PRIMARY: CostUnits = { wastedAttempts: 1, personTime: 2, lostRun: 5, actedWithoutApproval: 20 };

// Reported next to the primary table, so a verdict that flips within this range is visible.
export const SENSITIVITY: Array<[string, CostUnits]> = [
  ["lost run 2", { ...PRIMARY, lostRun: 2 }],
  ["lost run 10", { ...PRIMARY, lostRun: 10 }],
  ["no approval 10", { ...PRIMARY, actedWithoutApproval: 10 }],
  ["no approval 50", { ...PRIMARY, actedWithoutApproval: 50 }],
];

// cost(right action, chosen action); 0 when they match.
export function cost(right: Action, chosen: Action, u: CostUnits = PRIMARY): number {
  if (right === chosen) return 0;
  if (right === "escalate") return chosen === "fail" ? u.lostRun : u.actedWithoutApproval;
  if (chosen === "escalate") return u.personTime;
  if (chosen === "fail") return u.lostRun;
  if (right === "fail") return u.wastedAttempts;
  // Both retry, one with a hint and one without.
  return right === "retry_modified" ? 2 * u.wastedAttempts : u.wastedAttempts;
}

export interface Breakdown {
  cost: number;
  // Misses by direction: "right->chosen", for example "retry->fail".
  misses: Record<string, number>;
}

export function score(pairs: Array<[FailureKind, FailureKind]>, u: CostUnits = PRIMARY): Breakdown {
  const out: Breakdown = { cost: 0, misses: {} };
  for (const [label, verdict] of pairs) {
    const right = ACTION[label];
    const chosen = ACTION[verdict];
    if (right === chosen) continue;
    out.cost += cost(right, chosen, u);
    const key = `${right}->${chosen}`;
    out.misses[key] = (out.misses[key] ?? 0) + 1;
  }
  return out;
}

// One labelled case and the verdict of each classifier variant, per pass (without and with step context).
export interface CostRow {
  label: FailureKind;
  passes: Array<Record<string, FailureKind>>;
}

export function printCostReport(rows: CostRow[], variants: Array<[key: string, name: string]>): void {
  const width = Math.max(...variants.map(([, name]) => name.length));
  const total = (key: string, u: CostUnits) =>
    score(rows.flatMap((r) => r.passes.map((p) => [r.label, p[key]!] as [FailureKind, FailureKind])), u);
  console.log(`\nCost of wrong actions (eval-sets/COSTS.md), summed over ${rows[0]?.passes.length ?? 0} passes, lower is better:`);
  for (const [key, name] of variants) {
    const { cost: c, misses } = total(key, PRIMARY);
    const split = Object.entries(misses)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    console.log(`  ${name.padEnd(width)}  ${String(c).padStart(4)}   ${split || "no misses"}`);
  }
  console.log(`Sensitivity: ${SENSITIVITY.map(([label]) => label).join(" | ")}`);
  for (const [key, name] of variants) {
    console.log(`  ${name.padEnd(width)}  ${SENSITIVITY.map(([label, u]) => String(total(key, u).cost).padStart(label.length)).join(" | ")}`);
  }
}
