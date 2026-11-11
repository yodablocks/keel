import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const demo = fileURLToPath(new URL("../scripts/demo.ts", import.meta.url));

test("the agent demo shows every moment and completes", { timeout: 60_000 }, async () => {
  const child = spawn(process.execPath, [demo, "--offline"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  const [code] = await once(child, "exit");

  assert.equal(code, 0, out);
  const count = (text: string) => out.split(text).length - 1;

  // 1. hallucinated tool name, classified from the plain error message, retried with a hint
  assert.match(out, /classified as bad_output/);
  assert.match(out, /hint: .*serch_web/);
  // 2. crash mid-draft, recovery by another worker without re-calling the model for finished steps
  assert.match(out, /SIGKILL worker A/);
  assert.equal(count("calling model for research"), 1, "research ran once across both workers");
  assert.equal(count("calling model for plan (with hint)"), 1, "the corrected plan ran once across both workers");
  // 3. rate limit, classified transient, backed off
  assert.match(out, /classified as transient/);
  // 4. the follow-up could cross the budget, so it never starts: escalated while spend is still under it
  assert.match(out, /classified as over_budget/);
  assert.match(out, /spent \$0\.13 of its \$0\.15 budget, and step "follow-up" could cost up to \$0\.03/);
  assert.match(out, /\[run\] waiting \(attempt \d+, spent \$0\.13\)/, "paused under the $0.15 budget");
  assert.equal(count("calling model for follow-up"), 1, "the follow-up model call ran once, after approval");
  // 5. budget raised and approved by a reviewer, and the run completes
  assert.match(out, /reviewer raised the budget and approved/);
  assert.match(out, /run completed after \d+ attempts, spent \$0\.15/);
});
