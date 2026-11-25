import type {
  ResumeReason,
  RunnerEvent,
  RunPayload,
  RunStepResult,
} from '@agentic-studio/contracts';
import type { ProcessGroupRegistry } from './spawn-boundary.js';

/**
 * One Run step as it executes: a stream of events that ends with the structured result
 * (the generator's return value). Iterate it with {@link drainRunStep}.
 */
export type RunStep = AsyncGenerator<RunnerEvent, RunStepResult, void>;

/** Where a Run step works: the Run's prepared Working copy. */
export interface RunWorkspace {
  /** The Working copy, on the Run branch; the agent works here. */
  repoDir: string;
  /** The Run's directory: the Working copy and, beside it, the Task and the Run file. */
  runDir: string;
  /** Variables the Run step's processes get, e.g. `COMPOSE_PROJECT_NAME`. */
  env: Record<string, string>;
  /**
   * The absolute path of the agent's files, rebuilt for this step, when the agent has any. It is
   * named in the instructions and given to no CLI option: nothing loads it by itself.
   */
  agentFolder?: string | null;
}

export interface StartRunStepInput {
  /** It carries the base rules and the recorded agent that a real runner gives its agent. */
  run: RunPayload;
  workspace: RunWorkspace;
  /**
   * Aborted when the Run step must stop: the operator cancelled it, it reached its time limit,
   * the worker lost the Run or shuts down. The step must stop promptly; the worker
   * also interrupts, then kills, every process group registered in `processes`.
   */
  signal: AbortSignal;
  /** Where the step's process groups are registered; `spawnProviderCli` does it. */
  processes: ProcessGroupRegistry;
}

/**
 * A resumed Run step. A runner must continue exactly the session `sessionRef` names, in the same
 * Working copy, with `answer` as the agent's next message; a session the provider no longer has or
 * refuses is an {@link AgentFailedError}, never a new session.
 */
export interface ResumeRunStepInput extends StartRunStepInput {
  /**
   * The operator's message: the answer to the agent's question, "Continue where you stopped."
   * after the usage limit, or a Follow-up's text, as `reason` says.
   */
  answer: string;
  /** The agent session to continue, as the runner reported it with the question. */
  sessionRef: string;
  /** Why the session continues: a runner words the message after it. */
  reason: ResumeReason;
}

/**
 * The runner port: small and provider-agnostic. Each provider gets its own
 * adapter later; regular tests and this task use the fake runner. A runner throws
 * {@link AgentFailedError} when the agent fails, and anything else when it crashes.
 */
export interface Runner {
  /** The first Run step of a Run. */
  start(input: StartRunStepInput): RunStep;
  /** A Run step that resumes the Run's agent session with the operator's answer. */
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
 * The provider's subscription usage limit stopped the Run step. `message` is safe
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
