// keel benchmark: throughput for 1 to 32 workers, and enqueue-to-complete latency on idle workers.
// Every run executes one durable step. All workers share one Node process and one Postgres.
// Usage: pnpm bench [--runs 2000]
import os from "node:os";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { createEngine, migrate } from "../src/index.ts";
import type { TaskHandler } from "../src/index.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://keel:keel@localhost:5433/keel";
const { values } = parseArgs({ options: { runs: { type: "string" } } });
const RUNS = Number(values.runs ?? 2000);
const WORKER_COUNTS = [1, 2, 4, 8, 16, 32];
const LATENCY_SAMPLES = 200;

const task: TaskHandler = async (payload, ctx) => ctx.step.run("work", () => ({ n: (payload as { n: number }).n }));

await migrate(DATABASE_URL);
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

async function completed(queue: string): Promise<number> {
  return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM runs WHERE queue = $1 AND status = 'completed'`, [queue])).rows[0]!.n;
}

async function throughput(workers: number): Promise<{ workers: number; runsPerSecond: number; seconds: number }> {
  const engine = createEngine({ connectionString: DATABASE_URL, poolSize: workers + 4 });
  const queue = `bench-${randomUUID().slice(0, 8)}`;
  await db.query(`INSERT INTO runs (queue, task, payload) SELECT $1, 'bench', jsonb_build_object('n', i) FROM generate_series(1, $2) i`, [queue, RUNS]);
  const pool = Array.from({ length: workers }, () => engine.createWorker({ queue, tasks: { bench: task } }));
  const started = performance.now();
  for (const w of pool) w.start();
  while ((await completed(queue)) < RUNS) await sleep(20);
  const seconds = (performance.now() - started) / 1000;
  await Promise.all(pool.map((w) => w.stop()));
  await engine.purge({ olderThan: new Date(Date.now() + 60_000), queue });
  await engine.close();
  return { workers, runsPerSecond: Math.round(RUNS / seconds), seconds: Number(seconds.toFixed(2)) };
}

async function latency(): Promise<{ samples: number; p50ms: number; p99ms: number; maxMs: number }> {
  const engine = createEngine({ connectionString: DATABASE_URL, poolSize: 8 });
  const queue = `bench-${randomUUID().slice(0, 8)}`;
  const pool = Array.from({ length: 4 }, () => engine.createWorker({ queue, tasks: { bench: task } }));
  for (const w of pool) w.start();
  await sleep(200);
  for (let i = 0; i < LATENCY_SAMPLES; i++) {
    await engine.enqueue("bench", { n: i }, { queue });
    await sleep(25);
  }
  while ((await completed(queue)) < LATENCY_SAMPLES) await sleep(20);
  // Both timestamps come from Postgres, so client and server clocks cannot skew the result.
  const { rows } = await db.query<{ ms: number }>(
    `SELECT extract(epoch FROM updated_at - created_at) * 1000 AS ms FROM runs WHERE queue = $1 ORDER BY 1`,
    [queue],
  );
  await Promise.all(pool.map((w) => w.stop()));
  await engine.purge({ olderThan: new Date(Date.now() + 60_000), queue });
  await engine.close();
  const ms = rows.map((r) => Number(r.ms));
  const pct = (p: number) => Math.round(ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]!);
  return { samples: ms.length, p50ms: pct(0.5), p99ms: pct(0.99), maxMs: Math.round(ms[ms.length - 1]!) };
}

const postgres = (await db.query<{ v: string }>(`SELECT current_setting('server_version') AS v`)).rows[0]!.v;
const environment = {
  cpu: os.cpus()[0]?.model ?? "unknown",
  cores: os.cpus().length,
  memoryGb: Math.round(os.totalmem() / 1024 ** 3),
  platform: `${os.platform()} ${os.release()}`,
  node: process.version,
  postgres,
  note: "Postgres 17 in Docker on the same machine; all workers in one Node process; default 50ms polling",
};
console.log(`${environment.cpu}, ${environment.cores} cores, ${environment.memoryGb} GB, Node ${environment.node}, Postgres ${postgres}`);
console.log(`${RUNS} runs per configuration, one durable step per run\n`);

const results = [];
console.log("| Workers | Runs/s | Time |\n|---|---|---|");
for (const w of WORKER_COUNTS) {
  const r = await throughput(w);
  results.push(r);
  console.log(`| ${r.workers} | ${r.runsPerSecond} | ${r.seconds}s |`);
}
const lat = await latency();
console.log(`\nEnqueue to complete, 4 idle workers, ${lat.samples} runs: p50 ${lat.p50ms}ms, p99 ${lat.p99ms}ms, max ${lat.maxMs}ms`);

await mkdir("bench-results", { recursive: true });
const file = `bench-results/bench-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.json`;
await writeFile(file, JSON.stringify({ environment, runsPerConfiguration: RUNS, throughput: results, latency: lat }, null, 2));
console.log(`\nWrote ${file}`);
await db.end();
