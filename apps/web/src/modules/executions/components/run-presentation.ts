import type { PillStatus } from '@/shared/components/status-pill';
import type { RunOutput } from '../../../platform/api';

export type RunState = RunOutput['state'];
export type Provider = RunOutput['provider'];
export type FailureCode = NonNullable<RunOutput['failure']>['code'];

/**
 * How each Run state looks (design-system README, run-state colours): the pill colour and the
 * word. The design system has six colours for eight states, so `preparing` shares running's
 * colour (work is under way) and `timed_out` shares failed's (it stopped without a result); the
 * word tells them apart. Amber is only for the operator.
 */
export const RUN_STATE_VIEW: Record<RunState, { pill: PillStatus; label: string }> = {
  queued: { pill: 'queued', label: 'Queued' },
  preparing: { pill: 'running', label: 'Preparing' },
  running: { pill: 'running', label: 'Running' },
  waiting_for_operator: { pill: 'awaiting', label: 'Waiting for you' },
  succeeded: { pill: 'succeeded', label: 'Succeeded' },
  failed: { pill: 'failed', label: 'Failed' },
  cancelled: { pill: 'cancelled', label: 'Cancelled' },
  timed_out: { pill: 'failed', label: 'Timed out' },
};

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
};

/**
 * The Providers the New run dialog offers, Claude Code first. Which of them is available comes
 * from `GET /api/providers` (#101): the dialog disables an unavailable one with its reason and
 * preselects the first available.
 */
export const PROVIDER_OPTIONS: readonly { value: Provider; label: string }[] = [
  { value: 'claude_code', label: PROVIDER_LABEL.claude_code },
  { value: 'codex', label: PROVIDER_LABEL.codex },
];

/** One message per fixed failure code (#97 DoR); the Run's own detail follows in mono. */
export const FAILURE_MESSAGE: Record<FailureCode, string> = {
  provider_disabled: 'The provider is switched off on this server.',
  preparation_failed: "The run's working copy could not be prepared.",
  agent_failed: 'The agent stopped with an error.',
  usage_limit: "The provider's usage limit was reached.",
  worker_lost: 'The agent worker stopped responding.',
  delivery_failed: "The run's result could not be delivered.",
  unknown: 'The run failed for an unknown reason.',
};

/** States that hold a project (and a server slot): an agent worker or the operator has the Run. */
const HOLDING: readonly RunState[] = ['preparing', 'running', 'waiting_for_operator'];

/**
 * Why a queued Run waits, derived from its project's Runs (#97 DoR: no contract change): another
 * Run holds the project, or else the server's limit of active Runs is reached. The held states
 * and the limit of two mirror the API's concurrency rule (ADR 0002) for this message only; the
 * API alone decides when a Run starts.
 */
export function queuedReason(run: RunOutput, projectRuns: readonly RunOutput[]): string {
  const projectBusy = projectRuns.some(
    (other) => other.id !== run.id && HOLDING.includes(other.state),
  );
  return projectBusy
    ? 'Another run is active on this project. This one starts when it finishes.'
    : 'Waiting for a free slot: the server runs at most two runs at a time.';
}

/** The first line of the Task, for lists and titles; the full Task is on the Run page. */
export function taskSummary(task: string): string {
  return task.trim().split(/\r?\n/, 1)[0] ?? '';
}
