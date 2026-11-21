'use client';

import {
  ArrowLeftIcon,
  BanIcon,
  RotateCcwIcon,
  ClockIcon,
  FolderIcon,
  LockIcon,
  RefreshCwIcon,
  SearchXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Banner } from '@/shared/components/banner';
import { EmptyState } from '@/shared/components/empty-state';
import { StatusPill } from '@/shared/components/status-pill';
import { TabPanel, Tabs } from '@/shared/components/tabs';
import { formatDuration } from '@/shared/lib/duration';
import { formatExactTime } from '@/shared/lib/relative-time';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { ApiError, type RunOutput } from '../../../../platform/api';
import { useProjectRuns, useRun, useRunProject } from '../../api/runs-queries';
import {
  FAILURE_MESSAGE,
  PROVIDER_LABEL,
  queuedReason,
  RUN_STATE_VIEW,
  taskSummary,
} from '../../components/run-presentation';
import { failedRequest } from '../../components/failed-request';
import { FINAL_STATES } from '../../components/run-states';
import { StaleBanner } from '../../components/stale-banner';
import { CancelRunDialog } from '../cancel-run/cancel-run-dialog';
import { NewRunDialog } from '../new-run/new-run-dialog';
import { RunChanges } from '../run-changes/run-changes';
import { RunLog, type RunLogHandle } from '../run-log/run-log';
import { RunMergeReview } from '../run-merge-review/run-merge-review';
import { AnswerQuestion, RunConversation } from './run-conversation';
import { RunCommits, RunDelivery } from './run-delivery';
import { RunFollowUp } from './run-follow-up';
import { RunPullRequest } from './run-pull-request';
import { ResumeRun } from './run-resume';

/** The Run page's tabs: its log and what it changed. */
const RUN_TABS = [
  { value: 'log', label: 'Log' },
  { value: 'changes', label: 'Changes' },
];

/** The request the page makes (generated `getRun`), shown verbatim when it fails. */
const RUN_REQUEST = 'GET /api/runs/{runId}';

function LoadingRun() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading the run"
      className="flex flex-col gap-3"
    >
      <Skeleton className="h-7 w-72 max-w-full" />
      <Skeleton className="h-3.5 w-48" />
    </div>
  );
}

/** An exact time, or a dash while the Run has not got there. */
function When({ iso }: { iso: string | undefined }) {
  if (!iso) return <span className="text-text-dim">—</span>;
  return (
    <time dateTime={iso} className="tabular-nums">
      {formatExactTime(new Date(iso))}
    </time>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-caption font-medium text-text-dim">{term}</dt>
      <dd className="m-0 min-w-0 text-body">{children}</dd>
    </div>
  );
}

/**
 * Whether the Run was given its project's Environment file: it is decided when an agent worker
 * claims the Run, so a Run that has not started says so.
 */
function EnvironmentFileFact({ run }: { run: RunOutput }) {
  if (run.environmentFileSupplied) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <LockIcon aria-hidden="true" className="size-3.5 shrink-0 text-text-muted" />
        Environment file supplied
      </span>
    );
  }
  // A Run that ended without ever starting (cancelled while queued, failed at claim) got none.
  if (!run.startedAt && !FINAL_STATES.includes(run.state)) {
    return <span className="text-text-dim">Decided when the run starts</span>;
  }
  return <span className="text-text-dim">None</span>;
}

/**
 * What a Codex Run runs under: the agent worker's sandbox mode (ADR 0002; the only mode it
 * accepts, and each Run step states it in the log) and the accepted risks of the Codex
 * compliance record, which the Run page does not hide.
 */
function CodexFacts() {
  return (
    <>
      <Fact term="Sandbox">
        Codex workspace-write sandbox, network on
        <span className="block text-small text-text-muted">
          Set by the agent worker; each run step states it in the log.
        </span>
      </Fact>
      <Fact term="Accepted risks">
        <ul className="m-0 flex list-disc flex-col gap-1 pl-4 text-small">
          <li>Two Codex runs may share one ChatGPT plan login at the same time.</li>
          <li>Codex runs with the plan login may work on public repositories.</li>
        </ul>
      </Fact>
    </>
  );
}

/** Why a queued Run waits; it needs the project's Runs, read (and polled) only while queued. */
function QueuedReason({ run }: { run: RunOutput }) {
  // A Follow-up waits for the agent worker that holds the Working copy, and for a free place
  // under the concurrency limits like any queued Run.
  if (run.messages?.at(-1)?.kind === 'follow_up') {
    return <FollowUpQueuedReason run={run} />;
  }
  // An answered Run waits for the agent worker that holds its Working copy.
  if (run.messages?.at(-1)?.kind === 'answer') {
    return (
      <Banner tone="info" icon={ClockIcon} title="Answer sent.">
        The agent continues the run with your answer when its agent worker picks it up.
      </Banner>
    );
  }
  return <ProjectQueuedReason run={run} />;
}

function FollowUpQueuedReason({ run }: { run: RunOutput }) {
  const { data } = useProjectRuns(run.projectId);
  // A request to bring the Run branch up to date is a Follow-up of its own source.
  const bringUp = run.messages?.at(-1)?.source === 'bring_up_to_date';
  return (
    <Banner tone="info" icon={ClockIcon} title={bringUp ? 'Update requested.' : 'Follow-up sent.'}>
      {bringUp
        ? 'When its agent worker picks the run up, the integration branch is merged into the Run branch and the agent carries on from there.'
        : 'The agent continues the run with your Follow-up when its agent worker picks it up.'}
      {data ? ` ${queuedReason(run, data)}` : null}
    </Banner>
  );
}

function ProjectQueuedReason({ run }: { run: RunOutput }) {
  const { data } = useProjectRuns(run.projectId);
  // Until the project's Runs are known (or if they cannot be read), it still says it waits.
  return (
    <Banner tone="info" icon={ClockIcon} title="Waiting to start.">
      {data ? queuedReason(run, data) : null}
    </Banner>
  );
}

function Failure({ failure }: { failure: NonNullable<RunOutput['failure']> }) {
  return (
    <Banner tone="danger" title={FAILURE_MESSAGE[failure.code]}>
      {failure.detail ? (
        <span className="mt-1 block font-mono text-code break-words whitespace-pre-wrap">
          {failure.detail}
        </span>
      ) : null}
    </Banner>
  );
}

/** "Run again": the New run dialog, prefilled with the Run's Task and Provider. */
function RunAgain({ run }: { run: RunOutput }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" icon={RotateCcwIcon} onClick={() => setOpen(true)}>
        Run again
      </Button>
      <NewRunDialog
        projectId={run.projectId}
        initialValues={{ task: run.task, provider: run.provider }}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

/**
 * "Cancel run" for a Run that is not finished: a danger trigger and the destructive confirm.
 * Once a running Run carries a cancel request it shows "Cancel requested…" instead, until the
 * agent worker has stopped it.
 */
function CancelRun({ run, onCancel }: { run: RunOutput; onCancel: () => void }) {
  if (run.cancelRequestedAt) {
    return (
      <Button variant="danger" icon={BanIcon} disabled>
        Cancel requested…
      </Button>
    );
  }
  return (
    <Button variant="danger" icon={BanIcon} onClick={onCancel}>
      Cancel run
    </Button>
  );
}

/**
 * The header's action: "Run again" for a finished Run, "Cancel run" otherwise. The cancel
 * confirm lives here, outside that switch, so it stays open with its answer when the Run turns
 * final meanwhile.
 */
function RunActions({ run }: { run: RunOutput }) {
  const [cancelOpen, setCancelOpen] = useState(false);
  return (
    <>
      {FINAL_STATES.includes(run.state) ? (
        <RunAgain run={run} />
      ) : (
        <CancelRun run={run} onCancel={() => setCancelOpen(true)} />
      )}
      <CancelRunDialog run={run} open={cancelOpen} onOpenChange={setCancelOpen} />
    </>
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The limits in force for the Run, in words. */
function limitsText({
  stepMinutes,
  maxSteps,
  waitingDays,
  maxTotalSteps,
}: RunOutput['limits']): string {
  return [
    `${plural(stepMinutes, 'minute', 'minutes')} per run step`,
    `at most ${plural(maxSteps, 'run step', 'run steps')} per part (first part or Follow-up)`,
    `${plural(maxTotalSteps, 'run step', 'run steps')} in total`,
    `cancelled after ${plural(waitingDays, 'day', 'days')} waiting for you`,
  ].join(' · ');
}

/** The Run step totals: in total, and in the current part. */
function stepsText(run: RunOutput): string {
  const part = run.followUps > 0 ? 'in this Follow-up' : 'in this run';
  return (
    `${run.steps.used} of ${run.limits.maxTotalSteps} in total · ` +
    `${run.steps.usedInPart} of ${run.limits.maxSteps} ${part}`
  );
}

/** How a Run that was stopped ended: who cancelled it and why, or its time limit. */
function Stopped({ run }: { run: RunOutput }) {
  if (run.state === 'cancelled') {
    // A Run cancelled before reasons were recorded has none.
    return (
      <Banner
        tone="info"
        icon={BanIcon}
        title={run.cancellation?.reason || 'The run was cancelled.'}
      />
    );
  }
  if (run.state === 'timed_out') {
    return (
      <Banner
        tone="danger"
        icon={ClockIcon}
        title={`The run step reached its time limit of ${plural(run.limits.stepMinutes, 'minute', 'minutes')} and was stopped.`}
      />
    );
  }
  if (run.cancelRequestedAt && !FINAL_STATES.includes(run.state)) {
    return (
      <Banner tone="info" icon={BanIcon} title="Cancel requested.">
        The agent worker is stopping the run. It ends as cancelled; the working copy is kept.
      </Banner>
    );
  }
  return null;
}

function ProjectLink({ projectId }: { projectId: string }) {
  const { data } = useRunProject(projectId);
  return (
    <Link href={`/projects/${projectId}`} className="text-brand no-underline hover:underline">
      {data?.name ?? 'Project'}
    </Link>
  );
}

/** The Run's title (the start of its Task) for the Studio Shell breadcrumb, from the cached Run. */
export function RunTitle({ runId }: { runId: string }) {
  const { data } = useRun(runId);
  return <>{data ? taskSummary(data.task) : 'Run'}</>;
}

export function RunDetail({ runId }: { runId: string }) {
  const { data: run, error, isPending, isError, isRefetching, refetch } = useRun(runId);
  const log = useRef<RunLogHandle>(null);
  const [tab, setTab] = useState<'log' | 'changes'>('log');
  /** Shows where a Run step starts in the log, switching to the Log tab first. */
  const showStep = (index: number) => {
    if (tab !== 'log') flushSync(() => setTab('log'));
    return log.current?.showStep(index) ?? false;
  };

  if (isPending) return <LoadingRun />;
  // A failed background poll keeps the last known Run on screen (below); only a first load
  // that failed replaces the page.
  if (!run) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <EmptyState
          icon={SearchXIcon}
          title="Run not found"
          description="It may never have existed, or the link is wrong."
          action={
            <Button asChild icon={ArrowLeftIcon}>
              <Link href="/projects">Back to Projects</Link>
            </Button>
          }
        />
      );
    }
    return (
      <EmptyState
        tone="error"
        icon={TriangleAlertIcon}
        title="Couldn't load the run"
        description={
          <span className="font-mono text-small">{failedRequest(RUN_REQUEST, error)}</span>
        }
        action={
          <Button icon={RefreshCwIcon} loading={isRefetching} onClick={() => void refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const view = RUN_STATE_VIEW[run.state];
  const duration =
    run.startedAt && run.finishedAt
      ? formatDuration(Date.parse(run.finishedAt) - Date.parse(run.startedAt))
      : undefined;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex min-w-0 flex-col items-start gap-3 md:flex-row md:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="m-0 min-w-0 text-page-title font-semibold tracking-[-0.015em] break-words">
              {taskSummary(run.task)}
            </h1>
            <StatusPill status={view.pill}>{view.label}</StatusPill>
          </div>
          <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-text-muted">
            <span className="font-mono" title={run.id}>
              {run.id.slice(0, 8)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <FolderIcon aria-hidden="true" className="size-3.5" />
              <ProjectLink projectId={run.projectId} />
            </span>
          </p>
        </div>
        <RunActions run={run} />
      </header>

      {isError ? (
        <StaleBanner what="the run" retrying={isRefetching} onRetry={() => void refetch()} />
      ) : null}
      {run.question && run.state === 'waiting_for_operator' ? (
        <AnswerQuestion run={run} question={run.question} />
      ) : null}
      {run.state === 'queued' ? <QueuedReason run={run} /> : null}
      {run.failure ? <Failure failure={run.failure} /> : null}
      {run.resumable ? <ResumeRun run={run} /> : null}
      <Stopped run={run} />
      <RunDelivery run={run} />
      {run.pullRequest ? <RunPullRequest run={run} pullRequest={run.pullRequest} /> : null}
      {FINAL_STATES.includes(run.state) && run.followUp ? (
        <RunFollowUp run={run} followUp={run.followUp} />
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[2fr_1fr]">
        {/* Once the agent asked, the Task leads the conversation. */}
        {run.messages && run.messages.length > 1 ? (
          <RunConversation runId={run.id} messages={run.messages} onShowStep={showStep} />
        ) : (
          <Card aria-labelledby="run-task-title">
            <CardHeader>
              <CardTitle id="run-task-title">Task</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="m-0 break-words whitespace-pre-wrap">{run.task}</p>
            </CardContent>
          </Card>
        )}
        <Card aria-labelledby="run-facts-title">
          <CardHeader>
            <CardTitle id="run-facts-title">Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="m-0 flex flex-col gap-3.5">
              <Fact term="Provider">{PROVIDER_LABEL[run.provider]}</Fact>
              {run.provider === 'codex' ? <CodexFacts /> : null}
              <Fact term="Start commit">
                <span className="font-mono text-code break-all">{run.startCommit}</span>
              </Fact>
              {run.runBranch ? (
                <Fact term="Run branch">
                  <span className="font-mono text-code break-all">{run.runBranch}</span>
                </Fact>
              ) : null}
              <Fact term="Environment file">
                <EnvironmentFileFact run={run} />
              </Fact>
              <Fact term="Created">
                <When iso={run.createdAt} />
              </Fact>
              <Fact term="Started">
                <When iso={run.startedAt} />
              </Fact>
              <Fact term="Finished">
                <When iso={run.finishedAt} />
              </Fact>
              {duration ? (
                <Fact term="Duration">
                  <span className="font-mono text-code tabular-nums">{duration}</span>
                </Fact>
              ) : null}
              <Fact term="Run steps">
                <span className="tabular-nums">{stepsText(run)}</span>
              </Fact>
              <Fact term="Limits">{limitsText(run.limits)}</Fact>
            </dl>
          </CardContent>
        </Card>
      </div>

      <RunCommits run={run} />

      <Tabs
        items={RUN_TABS}
        label="Run"
        value={tab}
        onChange={(value) => setTab(value === 'changes' ? 'changes' : 'log')}
      >
        {/* Kept mounted while hidden: the live log keeps its stream and its place. */}
        <TabPanel value="log" forceMount>
          {/* A Follow-up reopens a finished Run, so its log opens again, live. */}
          <RunLog key={`${run.id}-${run.followUps}`} ref={log} run={run} />
        </TabPanel>
        <TabPanel value="changes">
          <div className="flex min-w-0 flex-col gap-8">
            <RunMergeReview run={run} />
            <section aria-labelledby="run-diff-title" className="flex min-w-0 flex-col gap-3">
              <h2 id="run-diff-title" className="m-0 text-body font-semibold text-text">
                Run diff, reported by the agent worker
              </h2>
              <RunChanges key={`${run.id}-${run.followUps}`} run={run} />
            </section>
          </div>
        </TabPanel>
      </Tabs>
    </div>
  );
}
