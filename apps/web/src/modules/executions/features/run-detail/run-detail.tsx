'use client';

import {
  ArrowLeftIcon,
  RotateCcwIcon,
  ClockIcon,
  FolderIcon,
  RefreshCwIcon,
  SearchXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { EmptyState } from '@/shared/components/empty-state';
import { StatusPill } from '@/shared/components/status-pill';
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
import { StaleBanner } from '../../components/stale-banner';
import { NewRunDialog } from '../new-run/new-run-dialog';

/** States in which a Run is over, so it can be run again. */
const FINAL: readonly RunOutput['state'][] = ['succeeded', 'failed', 'cancelled', 'timed_out'];

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

/** Why a queued Run waits; it needs the project's Runs, read (and polled) only while queued. */
function QueuedReason({ run }: { run: RunOutput }) {
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

/**
 * The Run page: the Task, the state as a status pill (polled while the Run is active), the
 * Provider, the project, the starting commit and the times. A queued Run says why it waits; a
 * failed Run shows the message for its reason code and the detail in mono; a finished one has
 * "Run again".
 */
export function RunDetail({ runId }: { runId: string }) {
  const { data: run, error, isPending, isError, isRefetching, refetch } = useRun(runId);

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
        {FINAL.includes(run.state) ? <RunAgain run={run} /> : null}
      </header>

      {isError ? (
        <StaleBanner what="the run" retrying={isRefetching} onRetry={() => void refetch()} />
      ) : null}
      {run.state === 'queued' ? <QueuedReason run={run} /> : null}
      {run.failure ? <Failure failure={run.failure} /> : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[2fr_1fr]">
        <Card aria-labelledby="run-task-title">
          <CardHeader>
            <CardTitle id="run-task-title">Task</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="m-0 break-words whitespace-pre-wrap">{run.task}</p>
          </CardContent>
        </Card>
        <Card aria-labelledby="run-facts-title">
          <CardHeader>
            <CardTitle id="run-facts-title">Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="m-0 flex flex-col gap-3.5">
              <Fact term="Provider">{PROVIDER_LABEL[run.provider]}</Fact>
              <Fact term="Start commit">
                <span className="font-mono text-code break-all">{run.startCommit}</span>
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
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
