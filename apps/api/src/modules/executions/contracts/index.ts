import type { Provider } from '@agentic-studio/agent-definitions';

export const PROVIDER_AVAILABILITIES = Symbol('PROVIDER_AVAILABILITIES');

/** Whether a Run can use a Provider now. */
export interface ProviderAvailabilityView {
  id: Provider;
  name: string;
  available: boolean;
  /** Why it is not available, as shown to the operator; absent when it is. */
  reason?: string;
}

export interface ProviderAvailabilities {
  /** Every Provider with its availability, from the agent workers' last reports. */
  list(): Promise<ProviderAvailabilityView[]>;
}

export const WORKFLOW_PLANS = Symbol('WORKFLOW_PLANS');

/** One item of a Workflow as a Run records it. A Phase is a `work` or `review` item. */
export type PlannedItem =
  | { id: string; kind: 'work' | 'review'; agent: string; instructions?: string }
  | { id: string; kind: 'checkpoint'; text: string };

/** The Workflow as resolved at a definitions commit: what a Run records of it. */
export interface WorkflowPlan {
  name: string;
  commit: string;
  items: PlannedItem[];
}

/**
 * `unknown`: no Workflow has the name at the commit. `not_usable`: it has problems, `reason` says
 * which (never a Provider's availability, which the Run's start judges).
 */
export type WorkflowResolution =
  | { status: 'resolved'; plan: WorkflowPlan }
  | { status: 'unknown' }
  | { status: 'not_usable'; reason: string };

/** What follows a Phase's result: the position of the next Phase, or the end of the Workflow. */
export type NextPhase = { kind: 'phase'; position: number } | { kind: 'end' };

/** How a Phase ended; only `done` exists until review Phases do. */
export type PhaseOutcome = 'done';

/** Implemented by `workflows`: `executions` imports nothing from it. */
export interface WorkflowPlans {
  /** The Workflow as it stands at the definitions Repository's last fetched commit. */
  resolve(projectId: string, name: string): Promise<WorkflowResolution>;
  /**
   * Pure over the recorded plan: the Phase after the one at `position` for `outcome`, or the end.
   * Called inside the transaction that records the Phase's result.
   */
  next(plan: WorkflowPlan, position: number, outcome: PhaseOutcome): NextPhase;
}
