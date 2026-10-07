// Labels an eval case file one case at a time, saving after each answer, so a session can stop and resume.
// Shows only the error, task, step and output: never recordedKind or any classifier result.
// Usage: pnpm eval:label <file>
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { FailureKind } from "../src/index.ts";

const KINDS: FailureKind[] = ["transient", "bad_input", "bad_output", "needs_human", "fatal"];
const HELP: Record<string, string> = {
  transient: "temporary problem outside the job; the same request later is likely to succeed",
  bad_input: "the job's own input is invalid; retrying with the same input fails again",
  bad_output: "a model or tool produced unusable output; a correction to the model is likely to help",
  needs_human: "cannot continue until a person decides, approves or provides something",
  fatal: "a bug or permanent problem in code or configuration; retrying won't help",
};

const file = process.argv[2];
if (file === undefined) {
  console.error("Usage: pnpm eval:label <file>");
  process.exit(1);
}
const cases = JSON.parse(await readFile(file, "utf8")) as Array<Record<string, unknown> & { label: FailureKind | null }>;
const todo = cases.filter((c) => c.label === null);
console.log(`${cases.length - todo.length} of ${cases.length} labelled. Keys: 1-5 to label, s to skip, q to quit.`);
KINDS.forEach((k, i) => console.log(`  ${i + 1} ${k.padEnd(11)} ${HELP[k]}`));

const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
let done = cases.length - todo.length;
for (const c of todo) {
  const error = c.error as Record<string, unknown>;
  console.log(`\n--- ${(c.id as string | undefined) ?? (c.runId as string | undefined) ?? ""} (${done + 1}/${cases.length})`);
  console.log(`task: ${String(c.task)}${c.step !== undefined ? `, step: ${String(c.step)}` : ""}`);
  console.log(`${String(error.name)}: ${String(error.message)}`);
  for (const field of ["status", "code", "cause"]) if (error[field] !== undefined) console.log(`  ${field}: ${String(error[field])}`);
  if (c.output !== undefined) console.log(`  output: ${JSON.stringify(c.output).slice(0, 300)}`);
  process.stdout.write("> ");
  const next = await lines.next();
  if (next.done === true) break;
  const answer = String(next.value).trim();
  if (answer === "q") break;
  const kind = KINDS[Number(answer) - 1];
  if (kind === undefined) continue;
  c.label = kind;
  done++;
  await writeFile(file, JSON.stringify(cases, null, 2) + "\n");
}
rl.close();
console.log(`\n${done} of ${cases.length} labelled in ${file}.`);
