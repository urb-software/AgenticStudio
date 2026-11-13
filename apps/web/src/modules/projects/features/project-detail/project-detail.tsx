'use client';

import { ArrowLeftIcon, RefreshCwIcon, SearchXIcon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/shared/components/empty-state';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { ApiError } from '../../../../platform/api';
import { useProject } from '../../api/projects-queries';
import { formatExactTime, formatTimeAgo } from '../../components/relative-time';
import { RepositoryCard } from '../repository-card/repository-card';

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
 * The project screen (prototype "project" view): the name and creation time, then the
 * Repository card. An unknown project shows a not-found state that links back to Projects.
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
      </div>
    </>
  );
}

/** The project's name for the Studio Shell breadcrumb, from the same cached query. */
export function ProjectName({ projectId }: { projectId: string }) {
  const { data } = useProject(projectId);
  return <>{data?.name ?? 'Project'}</>;
}
