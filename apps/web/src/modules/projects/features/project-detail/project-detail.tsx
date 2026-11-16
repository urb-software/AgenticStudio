'use client';

import { ArrowLeftIcon, RefreshCwIcon, SearchXIcon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/shared/components/empty-state';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { ProjectRuns, type RepositoryStatus } from '@/modules/executions';
import { ApiError, type RepositorySummaryOutput } from '../../../../platform/api';
import { useProject } from '../../api/projects-queries';
import { formatExactTime, formatTimeAgo } from '@/shared/lib/relative-time';
import { EnvironmentFileCard } from '../environment-file/environment-file-card';
import { RepositoryCard } from '../repository-card/repository-card';

/** Whether the project can start a Run: the API takes only a `ready` Repository. */
function repositoryStatus(summary: RepositorySummaryOutput | null): RepositoryStatus {
  if (summary === null) return 'missing';
  return summary.state === 'ready' ? 'ready' : 'not_ready';
}

function LoadingProject() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading the project"
      className="flex flex-col gap-3"
    >
      <Skeleton className="h-7 w-56 max-w-full" />
      <Skeleton className="h-3.5 w-32" />
    </div>
  );
}

/**
 * The project screen (prototype "project" view): the name and creation time, the Repository
 * card and the Environment file card (Issue #104), then the Runs section of the executions module. An unknown project shows a not-found
 * state that links back to Projects.
 */
export function ProjectDetail({ projectId }: { projectId: string }) {
  const { data, error, isPending, isError, isRefetching, refetch, dataUpdatedAt } =
    useProject(projectId);

  if (isPending) return <LoadingProject />;
  if (isError) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <EmptyState
          icon={SearchXIcon}
          title="Project not found"
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
        title="Couldn't load the project"
        description={
          <span className="font-mono text-small">
            GET /api/projects/{'{id}'}
            {error instanceof ApiError && error.status > 0 ? ` · ${error.status}` : ''}
          </span>
        }
        action={
          <Button icon={RefreshCwIcon} loading={isRefetching} onClick={() => void refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const createdAt = new Date(data.createdAt);
  return (
    <>
      <header className="flex min-w-0 flex-col gap-1">
        <h1 className="m-0 text-page-title font-semibold tracking-[-0.015em] break-words">
          {data.name}
        </h1>
        <p className="m-0 text-small text-text-dim">
          Created{' '}
          <time dateTime={data.createdAt} title={formatExactTime(createdAt)}>
            {formatTimeAgo(createdAt, dataUpdatedAt)}
          </time>
        </p>
      </header>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <RepositoryCard projectId={projectId} summary={data.repository} />
        <EnvironmentFileCard projectId={projectId} />
      </div>
      {/* The executions module owns the Runs section; this screen only composes it. */}
      <ProjectRuns projectId={projectId} repository={repositoryStatus(data.repository)} />
    </>
  );
}

/** The project's name for the Studio Shell breadcrumb, from the same cached query. */
export function ProjectName({ projectId }: { projectId: string }) {
  const { data } = useProject(projectId);
  return <>{data?.name ?? 'Project'}</>;
}
