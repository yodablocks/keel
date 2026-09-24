export type FailureKind = "transient" | "bad_input" | "bad_output" | "needs_human" | "over_budget" | "fatal";

export interface FailureContext {
  error: unknown;
  task: string;
  payload: unknown;
  /** The attempt that just failed, starting at 1. */
  attempt: number;
  maxAttempts: number;
}

export interface FailureVerdict {
  kind: FailureKind;
  /** 0 to 1. Rule matches on explicit signals are near 1, fallbacks are low. */
  confidence: number;
}

export interface FailureClassifier {
  classify(ctx: FailureContext): Promise<FailureVerdict>;
}

/** Throw from a handler when its input can never succeed, whatever the retry. */
export class BadInputError extends Error {
  override name = "BadInputError";
}

/** Throw from a handler when a model or tool produced unusable output (hallucinated tool, malformed JSON). */
export class BadOutputError extends Error {
  override name = "BadOutputError";
}

/** Throw from a handler when a person has to decide before the run can continue. */
export class NeedsHumanError extends Error {
  override name = "NeedsHumanError";
}

/** Thrown by ctx.step.run before a new step when the run has spent its budget. */
export class OverBudgetError extends Error {
  override name = "OverBudgetError";
}

const TRANSIENT_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "UND_ERR_SOCKET"]);
const TRANSIENT_NAMES = new Set(["TimeoutError"]);
const VALIDATION_NAMES = new Set(["ZodError", "ValidationError"]);

/** Classifies failures from explicit signals only: error classes, HTTP status, and network error codes. */
export class RuleClassifier implements FailureClassifier {
  async classify({ error }: FailureContext): Promise<FailureVerdict> {
    if (error instanceof BadInputError) return { kind: "bad_input", confidence: 1 };
    if (error instanceof BadOutputError) return { kind: "bad_output", confidence: 1 };
    if (error instanceof NeedsHumanError) return { kind: "needs_human", confidence: 1 };
    if (error instanceof OverBudgetError) return { kind: "over_budget", confidence: 1 };
    if (!(error instanceof Error)) return { kind: "fatal", confidence: 0.5 };

    const { status, statusCode, code } = error as Error & { status?: unknown; statusCode?: unknown; code?: unknown };
    const http = typeof status === "number" ? status : typeof statusCode === "number" ? statusCode : undefined;
    if (http !== undefined) {
      if (http === 408 || http === 429 || http >= 500) return { kind: "transient", confidence: 0.9 };
      if (http === 400 || http === 422) return { kind: "bad_input", confidence: 0.8 };
      return { kind: "fatal", confidence: 0.8 };
    }
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return { kind: "transient", confidence: 0.9 };
    if (TRANSIENT_NAMES.has(error.name)) return { kind: "transient", confidence: 0.9 };
    if (VALIDATION_NAMES.has(error.name)) return { kind: "bad_input", confidence: 0.7 };
    return { kind: "fatal", confidence: 0.5 };
  }
}

export type FailureAction =
  | { type: "retry"; delayMs: number }
  /** Retry with a hint the handler receives as ctx.hint, e.g. to correct a model's last output. */
  | { type: "retry_modified"; hint: string; delayMs?: number }
  /** Not routed yet (M6): the run fails with the target recorded. */
  | { type: "fallback"; target: string }
  /** Not routed yet (M8): the run fails with the reason recorded. */
  | { type: "escalate"; reason: string }
  | { type: "fail"; reason?: string };

/**
 * Decides what happens after a failure. The engine still caps retries at maxAttempts:
 * a retry action on the last attempt sends the run to `dead`.
 */
export type FailurePolicy = (verdict: FailureVerdict, ctx: FailureContext) => FailureAction;

export interface DefaultPolicyOptions {
  /** First retry waits up to this long. Each later retry doubles the ceiling. */
  baseMs?: number;
  maxMs?: number;
  random?: () => number;
}

/**
 * Transient failures retry with exponential backoff and full jitter. Bad output retries at once
 * with the error as a hint. Bad input and fatal errors fail. Needs-human and over-budget escalate.
 */
export function defaultPolicy(options: DefaultPolicyOptions = {}): FailurePolicy {
  const baseMs = options.baseMs ?? 1000;
  const maxMs = options.maxMs ?? 60_000;
  const random = options.random ?? Math.random;

  return (verdict, ctx) => {
    const message = ctx.error instanceof Error ? ctx.error.message : String(ctx.error);
    switch (verdict.kind) {
      case "transient": {
        const ceiling = Math.min(maxMs, baseMs * 2 ** (ctx.attempt - 1));
        return { type: "retry", delayMs: Math.floor(random() * ceiling) };
      }
      case "bad_output":
        return { type: "retry_modified", hint: `The previous attempt produced unusable output: ${message}` };
      case "needs_human":
      case "over_budget":
        return { type: "escalate", reason: message };
      case "bad_input":
      case "fatal":
        return { type: "fail", reason: message };
    }
  };
}
