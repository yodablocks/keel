// A real workload on keel: reads every confirmed job board from openroles, the maintainer's own job search tool
// (not published; its database defaults to ~/Coding_2026/openroles), one run per board, against the live Ashby, Greenhouse and Lever APIs. The openroles database is opened
// read-only; nothing is written back. Failures are the raw errors from fetch and JSON.parse, not keel's
// error classes, so the classifier sees what real failures look like.
// Uses Jev when TYPESAFE_API_KEY is set, rules otherwise (or with --offline).
// Usage: pnpm openroles:sync [--db path] [--workers 6] [--limit N] [--offline]
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { createEngine, JevClassifier, migrate, RuleClassifier } from "../src/index.ts";
import type { FailureClassifier, Run } from "../src/index.ts";

const { values } = parseArgs({
  options: {
    db: { type: "string", default: `${homedir()}/Coding_2026/openroles/data/openroles.sqlite3` },
    workers: { type: "string", default: "6" },
    limit: { type: "string" },
    offline: { type: "boolean", default: false },
  },
});

const BOARD_URL: Record<string, (board: string) => string> = {
  ashby: (b) => `https://api.ashbyhq.com/posting-api/job-board/${b}?includeCompensation=true`,
  greenhouse: (b) => `https://boards-api.greenhouse.io/v1/boards/${b}/jobs?content=true`,
  lever: (b) => `https://api.lever.co/v0/postings/${b}?mode=json`,
};
const IS_BOARD: Record<string, (data: unknown) => boolean> = {
  ashby: (d) => Array.isArray((d as { jobs?: unknown } | null)?.jobs),
  greenhouse: (d) => Array.isArray((d as { jobs?: unknown } | null)?.jobs),
  lever: (d) => Array.isArray(d),
};
const USER_AGENT = "openroles/0.1 (personal job search tool)";

interface Board {
  slug: string;
  source: string;
  board: string;
}

const sqlite = new DatabaseSync(values.db, { readOnly: true });
let boards = sqlite
  .prepare("SELECT slug, source, board FROM discovery WHERE state = 'board' ORDER BY slug")
  .all() as unknown as Board[];
sqlite.close();
boards = boards.filter((b) => b.source in BOARD_URL);
if (values.limit !== undefined) boards = boards.slice(0, Number(values.limit));

// At most one request per second per host, as in openroles. Workers share this process, and JavaScript runs one
// callback at a time, so reserving the next free slot per host is enough to space them out.
const nextSlot = new Map<string, number>();
async function politeTurn(host: string): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, slot + 1000);
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

async function readBoard({ source, board }: Board, signal: AbortSignal): Promise<{ jobs: number }> {
  const url = BOARD_URL[source]!(board);
  await politeTurn(new URL(url).host);
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (response.status === 403 || response.status === 429) {
    // The host is pushing back: hold every request to it for Retry-After, or a minute. openroles stops for the
    // whole run instead; keel's retries need the host back eventually, so this waits rather than gives up.
    const retryAfter = Number(response.headers.get("retry-after"));
    const coolMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60) * 1000;
    const host = new URL(url).host;
    nextSlot.set(host, Math.max(nextSlot.get(host) ?? 0, Date.now() + coolMs));
  }
  if (!response.ok) {
    throw Object.assign(new Error(`${source}:${board}: HTTP ${response.status} ${response.statusText}`), {
      status: response.status,
    });
  }
  const data: unknown = JSON.parse(await response.text());
  if (!IS_BOARD[source]!(data)) throw new Error(`${source}:${board}: the answer is not a job board`);
  const jobs = source === "lever" ? (data as unknown[]).length : (data as { jobs: unknown[] }).jobs.length;
  return { jobs };
}

async function makeClassifier(): Promise<{ classifier: FailureClassifier; name: string }> {
  if (!values.offline && process.env.TYPESAFE_API_KEY) {
    const { TypeSafeClient } = await import("@typesafe-ai/sdk");
    return { classifier: new JevClassifier({ client: new TypeSafeClient() }), name: "Jev cascade, jev-latest" };
  }
  return { classifier: new RuleClassifier(), name: "rules only" };
}

const connectionString = process.env.DATABASE_URL ?? "postgres://keel:keel@localhost:5433/keel";
await migrate(connectionString);
const engine = createEngine({ connectionString });
const queue = `openroles-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
const { classifier, name } = await makeClassifier();
console.log(`Reading ${boards.length} boards on queue ${queue} with ${values.workers} workers, classifier: ${name}`);

const started = Date.now();
const ids: string[] = [];
for (const b of boards) {
  const { id } = await engine.enqueue("read-board", b, { queue, maxAttempts: 3 });
  ids.push(id);
}

const workers = Array.from({ length: Number(values.workers) }, () =>
  engine.createWorker({
    queue,
    classifier,
    tasks: {
      "read-board": async (payload, ctx) => ctx.step.run("fetch-board", () => readBoard(payload as Board, ctx.signal)),
    },
  }),
);
for (const w of workers) w.start();

const FINAL = new Set(["completed", "failed", "dead"]);
let runs: Run[] = [];
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  runs = (await Promise.all(ids.map((id) => engine.getRun(id)))).filter((r): r is Run => r !== undefined);
  const done = runs.filter((r) => FINAL.has(r.status)).length;
  process.stdout.write(`\r${done} / ${ids.length} finished`);
  if (done === ids.length) break;
}
console.log();
await Promise.all(workers.map((w) => w.stop()));

const count = <T extends string>(xs: T[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
const errors = runs.flatMap((r) => r.errors.map((e) => ({ runId: r.id, task: r.task, ...e })));
const summary = {
  queue,
  classifier: name,
  at: new Date().toISOString(),
  durationSeconds: Math.round((Date.now() - started) / 1000),
  boards: boards.length,
  bySource: count(boards.map((b) => b.source)),
  byStatus: count(runs.map((r) => r.status)),
  jobs: runs.reduce((n, r) => n + ((r.result as { jobs?: number } | null)?.jobs ?? 0), 0),
  runsWithFailures: runs.filter((r) => r.errors.length > 0).length,
  failures: errors.length,
  failuresByKind: count(errors.map((e) => e.kind)),
  failuresByAction: count(errors.map((e) => e.action.type)),
  recoveredAfterRetry: runs.filter((r) => r.status === "completed" && r.errors.length > 0).length,
  errors: errors.map(({ runId, name: n, message, status, code, cause, kind, confidence, action, attempt }) => ({
    runId, attempt, name: n, message, status, code, cause, kind, confidence, action: action.type,
  })),
};
await mkdir("eval-results", { recursive: true });
const out = `eval-results/openroles-sync-${summary.at.slice(0, 19).replace(/:/g, "-")}.json`;
await writeFile(out, JSON.stringify(summary, null, 2));

const { errors: _, ...headline } = summary;
console.log(JSON.stringify(headline, null, 2));
console.log(`Wrote ${out}. Export the failures for labelling with: pnpm eval:export --queue ${queue} --blind`);
await engine.close();
