import type { RunnerEvent, RunPayload, RunStepResult } from '@agentic-studio/contracts';
import type { ProcessGroupRegistry } from './spawn-boundary.js';

/**
 * One Run step as it executes: a stream of events that ends with the structured result
 * (the generator's return value). Iterate it with {@link drainRunStep}.
 */
export type RunStep = AsyncGenerator<RunnerEvent, RunStepResult, void>;

/** Where a Run step works (Issue #98): the Run's prepared Working copy. */
export interface RunWorkspace {
  /** The Working copy, on the Run branch; the agent works here. */
  repoDir: string;
  /** The Run's directory: the Working copy and, beside it, the Task and the Run file. */
  runDir: string;
  /** Variables the Run step's processes get, e.g. `COMPOSE_PROJECT_NAME`. */
  env: Record<string, string>;
}

export interface StartRunStepInput {
  run: RunPayload;
  workspace: RunWorkspace;
  /**
   * Aborted when the Run step must stop: the operator cancelled it, it reached its time limit,
   * the worker lost the Run or shuts down (Issue #100). The step must stop promptly; the worker
   * also interrupts, then kills, every process group registered in `processes`.
   */
  signal: AbortSignal;
  /** Where the step's process groups are registered; `spawnProviderCli` does it (Issue #100). */
  processes: ProcessGroupRegistry;
}

export interface ResumeRunStepInput extends StartRunStepInput {
  /** The operator's answer to the agent's question. */
  answer: string;
}

/**
 * The runner port (Issue #96): small and provider-agnostic. Each provider gets its own
 * adapter later; regular tests and this task use the fake runner. A runner throws
 * {@link AgentFailedError} when the agent fails, and anything else when it crashes.
 */
export interface Runner {
  /** The first Run step of a Run. */
  start(input: StartRunStepInput): RunStep;
  /** A Run step that resumes the Run with the operator's answer (used from #103). */
  resume(input: ResumeRunStepInput): RunStep;
}

/** The agent itself failed (e.g. the CLI exited non-zero); `message` is safe to show. */
export class AgentFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentFailedError';
  }
}

/** Runs a step to its end, handing every event to `onEvent`; returns the structured result. */
export async function drainRunStep(
  step: RunStep,
  onEvent: (event: RunnerEvent) => void,
): Promise<RunStepResult> {
  for (;;) {
    const next = await step.next();
    if (next.done) return next.value;
    onEvent(next.value);
  }
}
