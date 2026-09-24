// Public entry point. Engine APIs land here milestone by milestone (see PLAN.md).
export const VERSION = "0.0.0";

export { createEngine } from "./engine.ts";
export type { Engine, EngineOptions, EnqueueOptions, Run, RunStatus, TaskHandler, Worker, WorkerOptions } from "./engine.ts";
