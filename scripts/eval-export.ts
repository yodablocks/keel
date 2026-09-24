// Exports real failures from the runs' error history into an eval case file for labelling.
// Usage: pnpm eval:export [--queue q] [--since 2026-09-01] [--limit 500] [--out file]
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { exportFailures } from "./eval-cases.ts";

const { values } = parseArgs({
  options: { queue: { type: "string" }, since: { type: "string" }, limit: { type: "string" }, out: { type: "string" } },
});
const cases = await exportFailures(process.env.DATABASE_URL ?? "postgres://keel:keel@localhost:5433/keel", {
  ...(values.queue !== undefined && { queue: values.queue }),
  ...(values.since !== undefined && { since: new Date(values.since) }),
  ...(values.limit !== undefined && { limit: Number(values.limit) }),
});
await mkdir("eval-results", { recursive: true });
const out = values.out ?? `eval-results/exported-${new Date().toISOString().slice(0, 10)}.json`;
await writeFile(out, JSON.stringify(cases, null, 2));
console.log(`Exported ${cases.length} failures to ${out}.`);
console.log('Set each "label" to the kind a person would choose, then run: pnpm eval:classifier --cases ' + out);
