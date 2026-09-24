// Public entry point. Engine APIs land here milestone by milestone (see PLAN.md).
export const VERSION = "0.0.0";

export { createEngine, DuplicateStepError, LeaseLostError, RunSuspended } from "./engine.ts";
export type { Engine, EngineOptions, EnqueueOptions, EnqueueResult, EventWaitResult, Run, RunError, RunStatus, StepApi, StepOptions, StopOptions, TaskContext, TaskHandler, Usage, WaitApi, Worker, WorkerOptions } from "./engine.ts";
export { migrate } from "./migrate.ts";
export { BadInputError, BadOutputError, defaultPolicy, NeedsHumanError, RuleClassifier } from "./failure.ts";
export type { DefaultPolicyOptions, FailureAction, FailureClassifier, FailureContext, FailureKind, FailurePolicy, FailureVerdict } from "./failure.ts";
