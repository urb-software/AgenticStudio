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
  /** The most send-backs per Run: the Workflow's own number, 0 to 2; absent means the default 2. */
  sendBacks?: number;
}

/**
 * `unknown`: no Workflow has the name at the commit. `not_usable`: it has problems, `reason` says
 * which (never a Provider's availability, which the Run's start judges).
 */
export type WorkflowResolution =
  | { status: 'resolved'; plan: WorkflowPlan }
  | { status: 'unknown' }
  | { status: 'not_usable'; reason: string };

/**
 * What follows a Phase's result or a Checkpoint: the position of the next Phase, the place among
 * the items of the Checkpoint the Run waits at, or the end of the Workflow.
 */
export type NextStep =
  { kind: 'phase'; position: number } | { kind: 'checkpoint'; item: number } | { kind: 'end' };

/** What follows a Phase's result: also a send-back to the work Phase at `position`. */
export type PhaseNext = NextStep | { kind: 'send_back'; position: number };

/** What a Run has used of its send-backs, and the review Phase owed a re-run. */
export interface SendBackState {
  used: number;
  returnTo?: number | null;
}

/** How a Phase ended: a work Phase is `done`, a review Phase gives its Verdict. */
export type PhaseOutcome = 'done' | 'approved' | 'changes_requested';

/** Implemented by `workflows`: `executions` imports nothing from it. */
export interface WorkflowPlans {
  /** The Workflow as it stands at the definitions Repository's last fetched commit. */
  resolve(projectId: string, name: string): Promise<WorkflowResolution>;
  /**
   * Pure over the recorded plan and the Run's send-back count: what follows the Phase at
   * `position` for `outcome`. Called inside the transaction that records the Phase's result.
   */
  next(
    plan: WorkflowPlan,
    position: number,
    outcome: PhaseOutcome,
    sendBacks?: SendBackState,
  ): PhaseNext;
  /** Pure over the recorded plan: what follows the Checkpoint at place `item` among the items. */
  afterCheckpoint(plan: WorkflowPlan, item: number): NextStep;
  /** Pure over the recorded plan: where a Run of it starts (a Checkpoint may come first). */
  first(plan: WorkflowPlan): NextStep;
}
