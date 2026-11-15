'use client';

import { ActivityIcon, PlayIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '@/shared/components/empty-state';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { useProjectRuns } from '../../api/runs-queries';
import { failedRequest } from '../../components/failed-request';
import { RunRows } from '../../components/run-rows';
import { StaleBanner } from '../../components/stale-banner';
import { NewRunDialog } from '../new-run/new-run-dialog';

/** The request the list makes (generated `listProjectRuns`), shown verbatim when it fails. */
const LIST_REQUEST = 'GET /api/projects/{id}/runs';

const TITLE_ID = 'project-runs-title';
const BLOCKED_ID = 'project-runs-blocked';

/** Whether the project can start a Run: the API needs a ready Repository. */
export type RepositoryStatus = 'missing' | 'not_ready' | 'ready';

const BLOCKED_REASON: Record<Exclude<RepositoryStatus, 'ready'>, string> = {
  missing: 'Connect a repository to start a run.',
  not_ready: 'The repository is not ready yet. Runs start from its integration branch.',
};

const SKELETON_ROWS = 3;

/** The failed request in mono: method, path and the problem+json status and title, never a body. */
function LoadingRuns() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading runs" className="flex flex-col">
      <span className="sr-only">Loading runs…</span>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className="flex items-center gap-3 border-b border-border py-3.5">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

type ProjectRunsProps = {
  projectId: string;
  /** The project's Repository, as far as starting a Run is concerned. */
  repository: RepositoryStatus;
};

/**
 * The Runs section of the project page: a primary "New run" action (disabled, with the reason,
 * until the project has a ready Repository) and the project's Runs, newest first, in the
 * design system's list states. The list is polled while a Run in it is active.
 */
export function ProjectRuns({ projectId, repository }: ProjectRunsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data, error, isPending, isError, isRefetching, refetch, dataUpdatedAt } =
    useProjectRuns(projectId);
  const blocked = repository === 'ready' ? undefined : BLOCKED_REASON[repository];

  let body;
  if (isPending) {
    body = <LoadingRuns />;
  } else if (!data) {
    body = (
      <EmptyState
        tone="error"
        icon={TriangleAlertIcon}
        title="Couldn't load the runs"
        description={
          <span className="font-mono text-small">{failedRequest(LIST_REQUEST, error)}</span>
        }
        action={
          <Button icon={RefreshCwIcon} loading={isRefetching} onClick={() => void refetch()}>
            Retry
          </Button>
        }
      />
    );
  } else if (data.length === 0) {
    body = (
      <EmptyState
        icon={ActivityIcon}
        title="Start your first run"
        description="A run hands a task to an agent, which works on it in its own copy of the repository. Use New run to start one."
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {isError ? (
          <StaleBanner what="the runs" retrying={isRefetching} onRetry={() => void refetch()} />
        ) : null}
        <RunRows runs={data} now={dataUpdatedAt} label="Runs" />
      </div>
    );
  }

  return (
    <>
      <Card aria-labelledby={TITLE_ID}>
        <CardHeader className="flex-wrap">
          <CardTitle id={TITLE_ID}>Runs</CardTitle>
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
            {blocked ? (
              <p id={BLOCKED_ID} className="m-0 text-small text-text-muted">
                {blocked}
              </p>
            ) : null}
            <Button
              // The section's one primary action, in every list state: its look never changes
              // under the operator (the empty state points at it instead of repeating it).
              variant="primary"
              size="sm"
              icon={PlayIcon}
              disabled={blocked !== undefined}
              aria-describedby={blocked ? BLOCKED_ID : undefined}
              onClick={() => setDialogOpen(true)}
            >
              New run
            </Button>
          </div>
        </CardHeader>
        <CardContent>{body}</CardContent>
      </Card>
      <NewRunDialog projectId={projectId} open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
