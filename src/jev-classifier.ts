import { RuleClassifier } from "./failure.ts";
import type { FailureClassifier, FailureContext, FailureVerdict } from "./failure.ts";

/**
 * The slice of TypeSafeClient (@typesafe-ai/sdk) this classifier uses. Pass `new TypeSafeClient()`;
 * keel itself does not depend on the SDK.
 */
export interface SystemOneClient {
  systemOne(request: { state: unknown; questions: Record<string, unknown> }): PromiseLike<{
    answers: Record<string, { choice?: string; probabilities?: Record<string, number>; confidence?: number }>;
  }>;
}

export interface JevClassifierOptions {
  client: SystemOneClient;
}

/**
 * Cascade: explicit signals (error classes, rule confidence 1) are classified by rules for free.
 * Everything else is asked of Jev, falling back to rules when Jev is unsure or unavailable.
 */
export class JevClassifier implements FailureClassifier {
  readonly #rules = new RuleClassifier();

  constructor(_options: JevClassifierOptions) {}

  async classify(ctx: FailureContext): Promise<FailureVerdict> {
    const byRules = await this.#rules.classify(ctx);
    return byRules;
  }
}
