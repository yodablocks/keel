import pg from "pg";
import { DATABASE_URL } from "./db.ts";

// A payment API that deduplicates on idempotency key, like Stripe. Backed by a table so that
// separate processes (a crashing child and a surviving worker) see the same charges.
export async function charge(idempotencyKey: string, amountCents: number): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS test_fake_payments (
      idempotency_key text PRIMARY KEY, amount_cents integer NOT NULL, calls integer NOT NULL DEFAULT 1)`);
    await client.query(
      `INSERT INTO test_fake_payments (idempotency_key, amount_cents) VALUES ($1, $2)
       ON CONFLICT (idempotency_key) DO UPDATE SET calls = test_fake_payments.calls + 1`,
      [idempotencyKey, amountCents],
    );
  } finally {
    await client.end();
  }
}

export async function paymentsFor(keyPrefix: string): Promise<Array<{ key: string; calls: number }>> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ key: string; calls: number }>(
      `SELECT idempotency_key AS key, calls FROM test_fake_payments WHERE idempotency_key LIKE $1 || '%'`,
      [keyPrefix],
    );
    return rows;
  } finally {
    await client.end();
  }
}
