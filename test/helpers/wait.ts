import { setTimeout as sleep } from "node:timers/promises";

// Polls until check returns a truthy value, or fails the test after timeoutMs.
export async function waitFor<T>(check: () => Promise<T | undefined | false>, timeoutMs = 5000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}
