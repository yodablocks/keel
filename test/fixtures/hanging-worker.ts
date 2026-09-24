// Runs a worker whose handler never finishes, so the parent test can SIGKILL it mid-run.
import { createEngine } from "../../src/index.ts";
import { DATABASE_URL } from "../helpers/db.ts";

const queue = process.env.KEEL_QUEUE!;
const leaseMs = Number(process.env.KEEL_LEASE_MS);

const engine = createEngine({ connectionString: DATABASE_URL });
const worker = engine.createWorker({
  queue,
  leaseMs,
  tasks: {
    work: async () => {
      process.stdout.write("started\n");
      await new Promise(() => {});
    },
  },
});
worker.start();
