// Builds an unlabelled eval set from error lines in public GitHub issues, mechanically: the repositories, queries,
// exclusions and sample are fixed here, so no case is picked by hand. Needs the gh CLI, logged in.
// Usage: node scripts/eval-harvest.ts --out eval-sets/fresh-issues.json [--size 60] [--prefix F]
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { FAILURE_CASES } from "./failure-cases.ts";

const { values } = parseArgs({
  options: { out: { type: "string" }, size: { type: "string", default: "60" }, prefix: { type: "string", default: "F" } },
});
if (values.out === undefined) throw new Error("--out is required");

// None of these were used for public-issues.json. Fixed before any of their issues were read.
const REPOS = [
  "googleapis/js-genai",
  "mastra-ai/mastra",
  "run-llama/LlamaIndexTS",
  "mistralai/client-ts",
  "ollama/ollama-js",
  "cohere-ai/cohere-typescript",
  // Added after the first run found only 40 eligible lines (count seen, no line read): more TypeScript agent and
  // workflow SDKs, including the durable execution engines keel competes with.
  "langchain-ai/langgraphjs",
  "huggingface/huggingface.js",
  "browserbase/stagehand",
  "triggerdotdev/trigger.dev",
  "inngest/inngest-js",
  "temporalio/sdk-typescript",
  "e2b-dev/E2B",
];
const QUERIES = ["Error", "fetch failed", "timeout", "429", "400", "JSON", "tool"];
const ALREADY_USED = ["openai/openai-node", "anthropics/anthropic-sdk-typescript", "vercel/ai", "langchain-ai/langchainjs", "nodejs/undici", "openai/openai-agents-js", "modelcontextprotocol/typescript-sdk"];

const ERROR_LINE = /^\s*(?:Uncaught\s+)?([A-Z][A-Za-z_]*(?:Error|Exception)|AI_[A-Za-z]+|Error)(?: \[([A-Z_]+)\])?: (.{8,400})$/;
const SDK_STATUS_CLASSES = new Set([
  "APIError", "BadRequestError", "AuthenticationError", "PermissionDeniedError", "NotFoundError", "ConflictError",
  "UnprocessableEntityError", "RateLimitError", "InternalServerError",
]);
const UNDICI_CODES: Record<string, string> = {
  ConnectTimeoutError: "UND_ERR_CONNECT_TIMEOUT",
  HeadersTimeoutError: "UND_ERR_HEADERS_TIMEOUT",
  BodyTimeoutError: "UND_ERR_BODY_TIMEOUT",
  SocketError: "UND_ERR_SOCKET",
};
const SYSCALL_CODE = /^(?:connect|read|write|getaddrinfo|request to \S+ failed, reason: \S+) (E[A-Z_]+)\b/;

// Lines that are not a whole runtime error: test assertions, and messages cut off where a code block line ends.
function excluded(name: string, message: string): boolean {
  if (/Assertion/.test(name)) return true;
  if (/[:{[(,]\s*$/.test(message)) return true;
  if ((message.match(/"/g) ?? []).length % 2 === 1) return true;
  if ((message.match(/`/g) ?? []).length % 2 === 1) return true;
  return false;
}

// Two lines that differ only in numbers, ids or case are the same error.
function normalize(line: string): string {
  return line.toLowerCase().replace(/[a-z0-9_-]*\d[a-z0-9_-]*/g, "#").replace(/\s+/g, " ").trim();
}

function search(repo: string, query: string): Array<{ url: string; body: string | null }> {
  const out = execFileSync("gh", ["search", "issues", "--repo", repo, "--limit", "40", "--json", "url,body", query], { encoding: "utf8" });
  return JSON.parse(out) as Array<{ url: string; body: string | null }>;
}

// Mulberry32: a small seeded generator, so the shuffle is the same on every run.
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seen = new Set<string>();
const previous = JSON.parse(await readFile("eval-sets/public-issues.json", "utf8")) as Array<{ reported: string }>;
for (const c of previous) seen.add(normalize(c.reported));
for (const c of FAILURE_CASES) if (c.error instanceof Error) seen.add(normalize(`${c.error.name}: ${c.error.message}`));

interface Harvested {
  repo: string;
  query: string;
  url: string;
  line: string;
  name: string;
  message: string;
  code?: string;
}
const found: Harvested[] = [];
for (const repo of REPOS) {
  if (ALREADY_USED.includes(repo)) throw new Error(`${repo} was used for public-issues.json`);
  for (const query of QUERIES) {
    await new Promise((r) => setTimeout(r, 7000)); // GitHub allows 30 searches a minute
    let issues: Array<{ url: string; body: string | null }>;
    try {
      issues = search(repo, query);
    } catch (err) {
      console.warn(`search failed for ${repo} "${query}":`, (err as Error).message.split("\n")[0]);
      continue;
    }
    for (const issue of issues) {
      for (const block of (issue.body ?? "").matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
        for (const raw of block[1]!.split("\n")) {
          const line = raw.trim();
          const m = ERROR_LINE.exec(line);
          if (m === null) continue;
          const [, name, bracketCode, message] = m as unknown as [string, string, string | undefined, string];
          if (excluded(name, message) || seen.has(normalize(line))) continue;
          seen.add(normalize(line));
          found.push({ repo, query, url: issue.url, line, name, message, ...(bracketCode !== undefined && { code: bracketCode }) });
        }
      }
    }
  }
  console.log(`${repo}: ${found.length} lines so far`);
}

const random = seeded(20261008);
for (let i = found.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [found[i], found[j]] = [found[j]!, found[i]!];
}
const sample = found.slice(0, Number(values.size));

const cases = sample.map((h, i) => {
  // status and code only where the error class itself carries them, as in public-issues.json.
  const status = SDK_STATUS_CLASSES.has(h.name) ? /^(\d{3})\b/.exec(h.message)?.[1] : undefined;
  const code = h.code ?? UNDICI_CODES[h.name] ?? SYSCALL_CODE.exec(h.message)?.[1];
  return {
    id: `${values.prefix}${String(i + 1).padStart(2, "0")}`,
    label: null,
    task: "agent",
    error: {
      name: h.name,
      message: h.message,
      ...(status !== undefined && { status: Number(status) }),
      ...(code !== undefined && { code }),
    },
    source: h.url,
    reported: h.line,
  };
});
await writeFile(values.out, JSON.stringify(cases, null, 2) + "\n");
console.log(`${found.length} eligible lines, ${cases.length} sampled into ${values.out}`);
