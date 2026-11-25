'use client';

import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { EmptyState } from '@/shared/components/empty-state';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { useProject } from '../../api/projects-queries';
import { RepositoryCard } from '../repository-card/repository-card';

/**
 * One Project's Repository card on its own: the connection steps, its state, the Integration
 * branch, the last fetched commit and Fetch. Other modules show it where the Repository belongs
 * to their screen (the Agents page), without the rest of the project page.
 */
export function ProjectRepository({
  projectId,
  autoFocusConnect,
  onRepositoryChanged,
}: {
  projectId: string;
  /** Puts focus on "Connect repository" when the Project has no Repository yet. */
  autoFocusConnect?: boolean;
  /** Called when the Repository changes state or is disconnected, so the screen can read the Clone again. */
  onRepositoryChanged?: () => void;
}) {
  const { data, isPending, isError, isRefetching, refetch } = useProject(projectId);

  if (isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading the Repository"
        className="flex flex-col gap-3"
      >
        <Skeleton className="h-3.5 w-64 max-w-full" />
        <Skeleton className="h-3.5 w-40" />
      </div>
    );
  }
  if (isError) {
    return (
      <EmptyState
        tone="error"
        icon={TriangleAlertIcon}
        title="Couldn't load the Repository"
        description={<span className="font-mono text-small">GET /api/projects/{'{id}'}</span>}
        action={
          <Button icon={RefreshCwIcon} loading={isRefetching} onClick={() => void refetch()}>
            Retry
          </Button>
        }
      />
    );
  }
  return (
    <RepositoryCard
      projectId={projectId}
      summary={data.repository}
      autoFocusConnect={autoFocusConnect}
      onRepositoryChanged={onRepositoryChanged}
    />
  );
}
