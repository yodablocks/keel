// Charges a payment, then hangs before the step can store its result, so the parent can SIGKILL it
// in the worst place: after the side effect, before keel knows it happened.
import { createEngine } from "../../src/index.ts";
import { DATABASE_URL } from "../helpers/db.ts";
import { charge } from "../helpers/fake-payments.ts";

const engine = createEngine({ connectionString: DATABASE_URL });
const worker = engine.createWorker({
  queue: process.env.KEEL_QUEUE!,
  leaseMs: Number(process.env.KEEL_LEASE_MS),
  tasks: {
    pay: async (_payload, ctx) =>
      ctx.step.run("charge", async ({ idempotencyKey }) => {
        await charge(idempotencyKey, 900);
        process.stdout.write("charged\n");
        await new Promise(() => {});
      }),
  },
});
worker.start();
