import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createEngine, migrate } from "../src/index.ts";
import { DATABASE_URL } from "./helpers/db.ts";

test("migrate sets up a fresh database and is safe to run again", async (t) => {
  const name = `keel_migrate_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  const fresh = url.toString();

  const engine = createEngine({ connectionString: fresh });
  t.after(async () => {
    await engine.close();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  await migrate(fresh);
  await migrate(fresh);

  const { id } = await engine.enqueue("noop", {});
  assert.equal((await engine.getRun(id))?.status, "queued");
});
