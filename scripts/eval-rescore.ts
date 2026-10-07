// Rescores a recorded eval:classifier result under other labellers' labels, without calling Jev again.
// Usage: node scripts/eval-rescore.ts --result <eval-results/....json> --cases <eval-sets/....json> <labels.json>...
// Each labels file maps case id to kind: {"F01": "fatal", ...}. The case file's own labels are scored as "human".
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import type { FailureKind } from "../src/index.ts";

const { values, positionals } = parseArgs({
  options: { result: { type: "string" }, cases: { type: "string" } },
  allowPositionals: true,
});
if (values.result === undefined || values.cases === undefined) throw new Error("--result and --cases are required");

const ACTION: Record<FailureKind, string> = {
  transient: "retry",
  bad_output: "retry_modified",
  bad_input: "fail",
  fatal: "fail",
  needs_human: "escalate",
  over_budget: "escalate",
};
type Verdicts = { cascade: FailureKind; cascadeBefore: FailureKind };
interface Row { message: string; label: FailureKind | null; withoutContext: Verdicts; withContext: Verdicts }

const rows = (JSON.parse(await readFile(values.result, "utf8")) as { rows: Row[] }).rows;
const cases = JSON.parse(await readFile(values.cases, "utf8")) as Array<{ id: string; label: FailureKind | null; error: { message: string } }>;
if (cases.length !== rows.length || cases.some((c, i) => c.error.message !== rows[i]!.message)) {
  throw new Error("result rows do not match the case file");
}

const labellers: Array<[string, Record<string, FailureKind>]> = [
  ["human", Object.fromEntries(cases.flatMap((c) => (c.label === null ? [] : [[c.id, c.label]])))],
];
for (const file of positionals) {
  const labels = JSON.parse(await readFile(file, "utf8")) as Record<string, FailureKind>;
  const missing = cases.filter((c) => !(labels[c.id]! in ACTION));
  if (missing.length > 0) throw new Error(`${file}: no valid kind for ${missing.map((c) => c.id).join(", ")}`);
  labellers.push([basename(file, ".json"), labels]);
}

console.log("Cascade after vs before the no-signal change, summed over both passes (without + with step context):");
console.log(`${"labeller".padEnd(10)} ${"kind after/before".padEnd(18)} ${"action after/before".padEnd(20)} fatal labels`);
for (const [name, labels] of labellers) {
  let kindAfter = 0, kindBefore = 0, actionAfter = 0, actionBefore = 0;
  cases.forEach((c, i) => {
    const label = labels[c.id];
    if (label === undefined) return;
    for (const v of [rows[i]!.withoutContext, rows[i]!.withContext]) {
      kindAfter += Number(v.cascade === label);
      kindBefore += Number(v.cascadeBefore === label);
      actionAfter += Number(ACTION[v.cascade] === ACTION[label]);
      actionBefore += Number(ACTION[v.cascadeBefore] === ACTION[label]);
    }
  });
  const fatal = Object.values(labels).filter((k) => k === "fatal").length;
  console.log(`${name.padEnd(10)} ${`${kindAfter}/${kindBefore}`.padEnd(18)} ${`${actionAfter}/${actionBefore}`.padEnd(20)} ${fatal}`);
}

console.log("\nAgreement on kind (cases both labelled):");
for (const [a, la] of labellers) {
  const cells = labellers.map(([, lb]) => {
    const both = cases.filter((c) => la[c.id] !== undefined && lb[c.id] !== undefined);
    return String(both.filter((c) => la[c.id] === lb[c.id]).length).padStart(4);
  });
  console.log(`${a.padEnd(10)}${cells.join("")}`);
}
console.log(`${"".padEnd(10)}${labellers.map(([n]) => n.slice(0, 4).padStart(4)).join("")}`);
