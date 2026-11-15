'use client';

import {
  ArrowLeftIcon,
  ClockIcon,
  FolderIcon,
  RefreshCwIcon,
  SearchXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
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

/** The request the page makes (generated `getRun`), shown verbatim when it fails. */
const RUN_REQUEST = 'GET /api/runs/{runId}';

function failedRequest(error: unknown): string {
  if (!(error instanceof ApiError) || error.status === 0) return RUN_REQUEST;
  const status = [error.status, error.problem?.title].filter(Boolean).join(' ');
  return `${RUN_REQUEST} · ${status}`;
}

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
  if (!data) return null;
  return (
    <Banner tone="info" icon={ClockIcon} title="Waiting to start.">
      {queuedReason(run, data)}
    </Banner>
  );
}

function Failure({ failure }: { failure: NonNullable<RunOutput['failure']> }) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2.5 rounded-lg border border-run-failed/35 bg-run-failed-soft p-4"
    >
      <p className="m-0 flex items-center gap-2 font-semibold text-run-failed">
        <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0" />
        {FAILURE_MESSAGE[failure.code]}
      </p>
      {failure.detail ? (
        <p className="m-0 font-mono text-code break-words whitespace-pre-wrap text-text">
          {failure.detail}
        </p>
      ) : null}
    </div>
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

/**
 * The Run page: the Task, the state as a status pill (polled while the Run is active), the
 * Provider, the project, the starting commit and the times. A queued Run says why it waits; a
 * failed Run shows the message for its reason code and the detail in mono.
 */
export function RunDetail({ runId }: { runId: string }) {
  const { data: run, error, isPending, isError, isRefetching, refetch } = useRun(runId);

  if (isPending) return <LoadingRun />;
  if (isError) {
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
        description={<span className="font-mono text-small">{failedRequest(error)}</span>}
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
      <header className="flex min-w-0 flex-col gap-2">
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
      </header>

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
