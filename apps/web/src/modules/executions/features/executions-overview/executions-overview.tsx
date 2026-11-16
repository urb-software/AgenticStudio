'use client';

import { ActivityIcon, FolderIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/shared/components/empty-state';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { useAllRuns, useProjectNames } from '../../api/runs-queries';
import { failedRequest } from '../../components/failed-request';
import { RunRows } from '../../components/run-rows';
import { StaleBanner } from '../../components/stale-banner';
import { AgentWorkerDisk } from './agent-worker-disk';

/** The request the list makes (generated `listRuns`), shown verbatim when it fails. */
const LIST_REQUEST = 'GET /api/runs';

const SKELETON_ROWS = 4;

/** No names: a project the list cannot name shows as unknown rather than failing the page. */
const NO_NAMES: ReadonlyMap<string, string> = new Map();

function LoadingRuns() {
  return (
    <Card role="status" aria-busy="true" aria-label="Loading runs" className="flex flex-col px-4">
      <span className="sr-only">Loading runs…</span>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 border-b border-border py-3.5 last:border-b-0"
        >
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </Card>
  );
}

/**
 * The Executions screen: every Run across all projects, newest first, with the project's name,
 * in the design system's list states (no filters yet, so no filtered-empty state). Runs start
 * from a project page, so the empty state leads there. Polled while a Run is active.
 */
export function ExecutionsOverview() {
  const runs = useAllRuns();
  const names = useProjectNames();

  let body;
  if (runs.isPending || (names.isPending && !names.isError)) {
    body = <LoadingRuns />;
  } else if (!runs.data) {
    body = (
      <EmptyState
        tone="error"
        icon={TriangleAlertIcon}
        title="Couldn't load the runs"
        description={
          <span className="font-mono text-small">{failedRequest(LIST_REQUEST, runs.error)}</span>
        }
        action={
          <Button
            icon={RefreshCwIcon}
            loading={runs.isRefetching}
            onClick={() => void runs.refetch()}
          >
            Retry
          </Button>
        }
      />
    );
  } else if (runs.data.length === 0) {
    body = (
      <EmptyState
        icon={ActivityIcon}
        title="No runs yet"
        description="Runs start from a project: open one with a connected repository and use New run."
        action={
          <Button asChild variant="primary" icon={FolderIcon}>
            <Link href="/projects">Go to Projects</Link>
          </Button>
        }
      />
    );
  } else {
    body = (
      <>
        {runs.isError ? (
          <StaleBanner
            what="the runs"
            retrying={runs.isRefetching}
            onRetry={() => void runs.refetch()}
          />
        ) : null}
        <Card className="px-4">
          <RunRows
            runs={runs.data}
            now={runs.dataUpdatedAt}
            label="Runs"
            projectNames={names.data ?? NO_NAMES}
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-page-title font-semibold tracking-[-0.015em]">Executions</h1>
        <p className="m-0 text-body text-text-muted">Every run across your projects.</p>
      </div>
      <AgentWorkerDisk />
      {body}
    </>
  );
}
