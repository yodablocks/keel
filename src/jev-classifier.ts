import { RuleClassifier } from "./failure.ts";
import type { FailureClassifier, FailureContext, FailureKind, FailureVerdict } from "./failure.ts";

const PAYLOAD_PREVIEW_CHARS = 2000;

// over_budget is never asked: only the engine raises it, always as an explicit OverBudgetError.
const FAILURE_KIND_QUESTION = {
  type: "choice",
  instructions:
    "A step of an automated job, often an AI agent, failed with `error`. Decide what kind of failure it is, " +
    "so the job engine can retry, retry with a correction, stop, or ask a person. Judge from `error`, `task` and `payload`.",
  criteria: {
    transient:
      "A temporary problem outside the job: rate limits, timeouts, overloaded or unavailable services, dropped connections. " +
      "Retrying the same request later is likely to succeed.",
    bad_input:
      "The job's own input is invalid or cannot be processed: missing or malformed fields, values that fail validation, " +
      "content too long for the model's context window. Retrying with the same input will fail again.",
    bad_output:
      "A model or tool produced unusable output: invalid JSON, a call to a tool or function that does not exist, " +
      "wrong or missing arguments, a response that breaks the required schema. Retrying with a correction to the model is likely to help.",
    needs_human:
      "The job cannot continue until a person decides: an action above an approval limit, a model refusal or policy block " +
      "that needs review, information or permission that only a person can provide.",
    fatal:
      "A bug or permanent problem in the code or configuration: type errors, undefined values, invalid credentials, " +
      "missing configuration or resources. Retrying will not help.",
  },
} as const;

/**
 * The slice of TypeSafeClient (@typesafe-ai/sdk) this classifier uses. Pass `new TypeSafeClient()`;
 * keel itself does not depend on the SDK.
 */
export interface SystemOneClient {
  // Answers are left loose: the SDK types them as a union of Choice, Noul and Score responses.
  systemOne(request: { state: unknown; questions: Record<string, unknown> }): PromiseLike<{
    answers: Readonly<Record<string, unknown>>;
  }>;
}

interface ChoiceAnswer {
  choice?: unknown;
  confidence?: unknown;
}

export interface JevClassifierOptions {
  client: SystemOneClient;
  /**
   * Jev answers below this confidence are ignored in favor of the rule verdict. Defaults to 0.5,
   * the TypeSafe docs' suggested floor for "do not act". Tune it on your own failures.
   */
  minConfidence?: number;
}

const ASKED_KINDS = new Set<string>(["transient", "bad_input", "bad_output", "needs_human", "fatal"]);

/**
 * Cascade: explicit signals (error classes, rule confidence 1) are classified by rules for free.
 * Everything else is asked of Jev, falling back to rules when Jev is unsure or unavailable.
 */
export class JevClassifier implements FailureClassifier {
  readonly #rules = new RuleClassifier();
  readonly #client: SystemOneClient;
  readonly #minConfidence: number;

  constructor(options: JevClassifierOptions) {
    this.#client = options.client;
    this.#minConfidence = options.minConfidence ?? 0.5;
  }

  async classify(ctx: FailureContext): Promise<FailureVerdict> {
    const byRules = await this.#rules.classify(ctx);
    if (byRules.confidence >= 1) return byRules;

    let answer: ChoiceAnswer | undefined;
    try {
      const response = await this.#client.systemOne({
        state: describeFailure(ctx),
        questions: { failure_kind: FAILURE_KIND_QUESTION },
      });
      answer = response.answers.failure_kind as ChoiceAnswer | undefined;
    } catch (err) {
      // A TypeSafe outage must not turn every failure into a classifier error.
      console.warn("[keel] Jev classification failed, using rules:", err);
      return byRules;
    }
    if (typeof answer?.choice !== "string" || !ASKED_KINDS.has(answer.choice)) return byRules;
    const confidence = typeof answer.confidence === "number" ? answer.confidence : 0;
    if (confidence < this.#minConfidence) return byRules;
    return { kind: answer.choice as FailureKind, confidence };
  }
}

function describeFailure(ctx: FailureContext) {
  const err = ctx.error;
  const fields = err instanceof Error ? (err as Error & { status?: unknown; statusCode?: unknown; code?: unknown }) : undefined;
  const payload = JSON.stringify(ctx.payload) ?? "null";
  return {
    task: ctx.task,
    attempt: `${ctx.attempt} of ${ctx.maxAttempts}`,
    error: {
      name: fields?.name ?? typeof err,
      message: fields?.message ?? String(err),
      ...(fields?.status !== undefined && { status: fields.status }),
      ...(fields?.statusCode !== undefined && { status: fields.statusCode }),
      ...(fields?.code !== undefined && { code: fields.code }),
      ...(fields?.cause !== undefined && { cause: describeCause(fields.cause) }),
    },
    payload: payload.length > PAYLOAD_PREVIEW_CHARS ? `${payload.slice(0, PAYLOAD_PREVIEW_CHARS)}... (truncated)` : payload,
  };
}

function describeCause(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const code = (cause as Error & { code?: unknown }).code;
  return `${cause.name}: ${cause.message}${code !== undefined ? ` (code ${String(code)})` : ""}`;
}
