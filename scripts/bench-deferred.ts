// Measures how 10,000 deferred runs of one over-budget tenant affect everyone else's runs.
// Scenarios: no deferred runs; 10k deferred with parking disabled (the pre-M10 behavior); 10k parked.
// Creates its own queues and removes their rows afterwards.
import pg from "pg";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createEngine, migrate } from "../src/index.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://keel:keel@localhost:5433/keel";
const DEFERRED = 10_000;
const OTHERS = 300;
const WORKERS = 4;

await migrate(DATABASE_URL);
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

async function scenario(label: string, deferred: number, park: boolean): Promise<number> {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = `bench-${randomUUID().slice(0, 8)}`;
  const overTenant = `over-${queue}`;
  await engine.setTenantBudget(overTenant, { usdPerDay: 0 }); // spend 0 >= 0: over budget from the start
  if (deferred > 0) {
    await db.query(
      `INSERT INTO runs (queue, task, payload, tenant) SELECT $1, 'noop', '{}', $2 FROM generate_series(1, $3)`,
      [queue, overTenant, deferred],
    );
  }

  const sweepEveryMs = park ? 200 : 1e9;
  const workers = Array.from({ length: WORKERS }, () =>
    engine.createWorker({ queue, sweepEveryMs, tasks: { noop: async () => null } }),
  );
  if (park) {
    // Let one sweep park the deferred runs before measuring.
    const sweeper = engine.createWorker({ queue, sweepEveryMs: 50, tasks: {} });
    sweeper.start();
    while ((await db.query(`SELECT count(*)::int AS n FROM runs WHERE queue = $1 AND deferred_run_after IS NOT NULL`, [queue])).rows[0].n < deferred) {
      await sleep(50);
    }
    await sweeper.stop();
  }

  const ids: string[] = [];
  for (let i = 0; i < OTHERS; i++) ids.push((await engine.enqueue("noop", {}, { queue, tenant: `ok-${queue}` })).id);
  const started = performance.now();
  for (const w of workers) w.start();
  while ((await db.query(`SELECT count(*)::int AS n FROM runs WHERE id = ANY($1) AND status = 'completed'`, [ids])).rows[0].n < OTHERS) {
    await sleep(10);
  }
  const elapsed = performance.now() - started;
  await Promise.all(workers.map((w) => w.stop()));
  await engine.close();
  await db.query(`DELETE FROM runs WHERE queue = $1`, [queue]);
  await db.query(`DELETE FROM tenant_budgets WHERE tenant = $1`, [overTenant]);

  console.log(`${label.padEnd(40)} ${OTHERS} runs in ${elapsed.toFixed(0).padStart(6)} ms  (${((OTHERS / elapsed) * 1000).toFixed(0)} runs/s)`);
  return elapsed;
}

console.log(`${WORKERS} workers, ${OTHERS} runs of an in-budget tenant, one Postgres\n`);
await scenario("no deferred runs", 0, false);
await scenario(`${DEFERRED} deferred runs, parking off`, DEFERRED, false);
await scenario(`${DEFERRED} deferred runs, parked (M10)`, DEFERRED, true);
await db.end();
