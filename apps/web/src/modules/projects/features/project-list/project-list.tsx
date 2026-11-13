'use client';

import { FolderIcon, PlusIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { EmptyState } from '@/shared/components/empty-state';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { ApiError } from '../../../../platform/api';
import { useProjects } from '../../api/projects-queries';
import { formatExactTime, formatTimeAgo } from './relative-time';

/** The request the list makes (generated `listProjects`), shown verbatim when it fails. */
const LIST_REQUEST = 'GET /api/projects';

/** Phones: one column. Wider: as many 290px+ columns as fit (prototype `.pgrid`). */
const GRID = 'grid grid-cols-1 gap-3.5 md:grid-cols-[repeat(auto-fill,minmax(290px,1fr))]';

const SKELETON_CARDS = 3;

/** The failed request in mono: method, path and the problem+json status and title, never a body. */
function failedRequest(error: unknown): string {
  if (!(error instanceof ApiError) || error.status === 0) return LIST_REQUEST;
  const status = [error.status, error.problem?.title].filter(Boolean).join(' ');
  return `${LIST_REQUEST} · ${status}`;
}

function LoadingProjects() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading projects" className={GRID}>
      <span className="sr-only">Loading projects…</span>
      {Array.from({ length: SKELETON_CARDS }, (_, index) => (
        <Card key={index} className="gap-3 p-4">
          <Skeleton className="h-3.5 w-36" />
          <Skeleton className="h-3 w-24" />
        </Card>
      ))}
    </div>
  );
}

type ProjectListProps = {
  /** Opens the New project dialog (the empty state's action). */
  onCreateProject: () => void;
};

/** The operator's projects, newest first, in the five list states of the design system. */
export function ProjectList({ onCreateProject }: ProjectListProps) {
  const { data, error, isPending, isError, isRefetching, refetch, dataUpdatedAt } = useProjects();

  if (isPending) {
    return <LoadingProjects />;
  }
  if (isError) {
    return (
      <EmptyState
        tone="error"
        icon={TriangleAlertIcon}
        title="Couldn't load projects"
        description={<span className="font-mono text-small">{failedRequest(error)}</span>}
        action={
          <Button icon={RefreshCwIcon} loading={isRefetching} onClick={() => void refetch()}>
            Retry
          </Button>
        }
      />
    );
  }
  if (data.items.length === 0) {
    return (
      <EmptyState
        icon={FolderIcon}
        title="Create your first project"
        description="A project is a workspace around one repository."
        action={
          <Button variant="primary" icon={PlusIcon} onClick={onCreateProject}>
            Create project
          </Button>
        }
      />
    );
  }
  // Relative to when the list was fetched: a fixed "now" that only exists in the browser.
  return (
    <ul role="list" aria-label="Projects" className={cn('m-0 list-none p-0', GRID)}>
      {data.items.map((project) => {
        const createdAt = new Date(project.createdAt);
        return (
          <li key={project.id} className="min-w-0">
            <Card className="h-full gap-1.5 p-4">
              <h2 className="m-0 truncate text-body font-semibold">{project.name}</h2>
              <p className="m-0 text-caption text-text-dim">
                Created{' '}
                <time dateTime={project.createdAt} title={formatExactTime(createdAt)}>
                  {formatTimeAgo(createdAt, dataUpdatedAt)}
                </time>
              </p>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
