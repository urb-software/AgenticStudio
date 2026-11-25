import type { PillStatus } from '@/shared/components/status-pill';
import type { RunOutput } from '../../../platform/api';

export type RunState = RunOutput['state'];
export type Provider = RunOutput['provider'];
export type FailureCode = NonNullable<RunOutput['failure']>['code'];

/**
 * The design system has six colours for eight states: `preparing` shares running's colour (work
 * is under way) and `timed_out` shares failed's; the word tells them apart. Amber is only for
 * the operator.
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

export type PullRequestState = NonNullable<NonNullable<RunOutput['pullRequest']>['state']>;

/**
 * Colours follow the run states' meaning without borrowing amber, which is only for the
 * operator.
 */
export const PULL_REQUEST_STATE_VIEW: Record<
  PullRequestState,
  { pill: PillStatus; label: string }
> = {
  draft: { pill: 'queued', label: 'Draft' },
  open: { pill: 'running', label: 'Open' },
  merged: { pill: 'succeeded', label: 'Merged' },
  closed: { pill: 'cancelled', label: 'Closed' },
  missing: { pill: 'failed', label: 'Missing' },
};

type PullRequestChecks = NonNullable<NonNullable<RunOutput['pullRequest']>['checks']>;
export type PullRequestCheckState = PullRequestChecks[number]['state'];

/**
 * How a Pull request check's state looks: the pill colour and the word. Colours follow the run
 * states' meaning without amber: queued and skipped are quiet, running is under way, passed is
 * done, failed is red and cancelled is an outline. The word always says it too.
 */
export const PULL_REQUEST_CHECK_VIEW: Record<
  PullRequestCheckState,
  { pill: PillStatus; label: string }
> = {
  queued: { pill: 'queued', label: 'Queued' },
  running: { pill: 'running', label: 'Running' },
  passed: { pill: 'succeeded', label: 'Passed' },
  failed: { pill: 'failed', label: 'Failed' },
  skipped: { pill: 'cancelled', label: 'Skipped' },
  cancelled: { pill: 'cancelled', label: 'Cancelled' },
};

/** The overall picture of a pull request's checks. */
export interface ChecksSummary {
  /** The summary line, e.g. "1 of 12 checks failed". */
  text: string;
  /** The marker next to the pull request state in the lists: only a result is marked. */
  marker: 'failed' | 'passed' | 'pending' | 'none';
  failed: number;
  /** Queued or running: the page refreshes the checks while any is. */
  unfinished: number;
}

const checksWord = (count: number) => `${count} ${count === 1 ? 'check' : 'checks'}`;

/** The summary line and list marker of a list of checks, from their states alone (no extra call). */
export function summarizeChecks(checks: PullRequestChecks): ChecksSummary {
  const total = checks.length;
  const count = (state: PullRequestCheckState) =>
    checks.filter((check) => check.state === state).length;
  const failed = count('failed');
  const running = count('running');
  const queued = count('queued');
  const unfinished = running + queued;
  const cancelled = count('cancelled');
  if (total === 0) return { text: 'No checks', marker: 'none', failed, unfinished };
  if (failed > 0) {
    return {
      text:
        `${failed} of ${checksWord(total)} failed` +
        (unfinished > 0 ? `, ${unfinished} not finished` : ''),
      marker: 'failed',
      failed,
      unfinished,
    };
  }
  if (queued === total) {
    return { text: 'Checks have not started yet', marker: 'pending', failed, unfinished };
  }
  if (unfinished > 0) {
    return {
      text: `${unfinished} of ${checksWord(total)} still running or waiting`,
      marker: 'pending',
      failed,
      unfinished,
    };
  }
  if (cancelled > 0) {
    return {
      text: `${cancelled} of ${checksWord(total)} cancelled`,
      marker: 'none',
      failed,
      unfinished,
    };
  }
  const passed = count('passed');
  const skipped = count('skipped');
  const text =
    skipped === 0
      ? total === 1
        ? 'The check passed'
        : `All ${total} checks passed`
      : passed === 0
        ? total === 1
          ? 'The check was skipped'
          : `All ${total} checks were skipped`
        : `${passed} ${passed === 1 ? 'check' : 'checks'} passed, ${skipped} skipped`;
  return { text, marker: passed > 0 ? 'passed' : 'none', failed, unfinished };
}

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
};

/**
 * The Providers the New run dialog offers, Claude Code first. Which of them is available comes
 * from `GET /api/providers`: the dialog disables an unavailable one with its reason and
 * preselects the first available.
 */
export const PROVIDER_OPTIONS: readonly { value: Provider; label: string }[] = [
  { value: 'claude_code', label: PROVIDER_LABEL.claude_code },
  { value: 'codex', label: PROVIDER_LABEL.codex },
];

/** One message per fixed failure code; the Run's own detail follows in mono. */
export const FAILURE_MESSAGE: Record<FailureCode, string> = {
  provider_disabled: 'The provider is switched off on this server.',
  preparation_failed: "The run's working copy could not be prepared.",
  agent_failed: 'The agent stopped with an error.',
  usage_limit: "The provider's usage limit was reached.",
  worker_lost: 'The agent worker stopped responding.',
  delivery_failed: "The run's result could not be delivered.",
  step_limit: 'The run reached its maximum number of run steps.',
  agent_folder_unavailable:
    "The agent's files are no longer available in the definitions Repository.",
  agent_folder_invalid: "The agent's files in the definitions Repository are not valid.",
  model_not_allowed: "The agent's model is not one the provider allows.",
  model_refused: "The provider refused the agent's model.",
  unknown: 'The run failed for an unknown reason.',
};

/** States that hold a project (and a server slot): an agent worker or the operator has the Run. */
const HOLDING: readonly RunState[] = ['preparing', 'running', 'waiting_for_operator'];

/**
 * The held states and the limit of two mirror the API's concurrency rule (ADR 0002) for this
 * message only; the API alone decides when a Run starts.
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
