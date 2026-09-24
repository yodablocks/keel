// Starts the keel dashboard. Usage: pnpm dashboard [--port 4400] [--host 127.0.0.1]
import { parseArgs } from "node:util";
import { createEngine, startDashboard } from "../src/index.ts";

const { values } = parseArgs({ options: { port: { type: "string" }, host: { type: "string" } } });
const host = values.host ?? "127.0.0.1";
const engine = createEngine({ connectionString: process.env.DATABASE_URL ?? "postgres://keel:keel@localhost:5433/keel" });
const dashboard = await startDashboard({ engine, host, port: values.port ? Number(values.port) : 4400 });

console.log(`keel dashboard: ${dashboard.url}`);
if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
  console.warn(`WARNING: listening on ${host}. The dashboard has no login; anyone who can reach it can approve runs.`);
}
process.on("SIGINT", async () => {
  await dashboard.close();
  await engine.close();
  process.exit(0);
});
