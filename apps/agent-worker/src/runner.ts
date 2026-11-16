import type { RunnerEvent, RunPayload, RunStepResult } from '@agentic-studio/contracts';
import type { AgentDefinition } from './agent-definition/index.js';
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
  /**
   * The built-in agent definition (Issue #103): a real runner gives it to its agent with the
   * Task (it says when to ask the operator and what the structured result is).
   */
  agentDefinition: AgentDefinition;
}

/**
 * A resumed Run step (Issue #103). A runner must continue exactly the session `sessionRef`
 * names (the one its earlier step reported) in the same Working copy, with `answer` as the
 * agent's next message, so the agent keeps its earlier context. A session the provider no
 * longer has, or refuses, is an {@link AgentFailedError} with the reason; the runner never
 * starts a new session instead.
 */
export interface ResumeRunStepInput extends StartRunStepInput {
  /** The operator's answer to the agent's question. */
  answer: string;
  /** The agent session to continue, as the runner reported it with the question. */
  sessionRef: string;
}

/**
 * The runner port (Issue #96): small and provider-agnostic. Each provider gets its own
 * adapter later; regular tests and this task use the fake runner. A runner throws
 * {@link AgentFailedError} when the agent fails, and anything else when it crashes.
 */
export interface Runner {
  /** The first Run step of a Run. */
  start(input: StartRunStepInput): RunStep;
  /** A Run step that resumes the Run's agent session with the operator's answer (#103). */
  resume(input: ResumeRunStepInput): RunStep;
}

/** The agent itself failed (e.g. the CLI exited non-zero); `message` is safe to show. */
export class AgentFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentFailedError';
  }
}

/**
 * The provider's subscription usage limit stopped the Run step (Issue #105). `message` is safe
 * to show (it says when the limit resets, when the CLI reported it); `sessionRef` is the agent
 * session the step ran in, so the operator can resume the Run once the limit has reset.
 */
export class UsageLimitError extends Error {
  constructor(
    message: string,
    readonly sessionRef?: string,
  ) {
    super(message);
    this.name = 'UsageLimitError';
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
