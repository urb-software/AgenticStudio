'use client';

import { FolderIcon, PlusIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/shared/components/empty-state';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { ApiError, type ProjectOutput } from '../../../../platform/api';
import { Badge } from '@/shared/components/badge';
import { StatusPill } from '@/shared/components/status-pill';
import { usePreviewStates, useProjects } from '../../api/projects-queries';
import { formatExactTime, formatTimeAgo } from '@/shared/lib/relative-time';

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

/** "Preview running" or "Building" for a Project whose Preview takes a place; nothing otherwise. */
function PreviewBadge({ state }: { state: string | undefined }) {
  if (state !== 'running' && state !== 'building') return null;
  return (
    <div>
      {state === 'running' ? (
        <StatusPill status="succeeded">Preview running</StatusPill>
      ) : (
        <StatusPill status="running">Building</StatusPill>
      )}
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
  const previews = usePreviewStates().data;

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
  // The definitions Repository is not an ordinary Project: it sits apart, above them.
  const definitions = data.items.find((project) => project.kind === 'definitions');
  const ordinary = data.items.filter((project) => project.kind !== 'definitions');
  const empty =
    ordinary.length === 0 ? (
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
    ) : null;
  // Relative to when the list was fetched: a fixed "now" that only exists in the browser.
  const now = dataUpdatedAt;
  return (
    <>
      {definitions ? (
        <section aria-labelledby="definitions-repository-title" className="flex flex-col gap-3">
          <h2
            id="definitions-repository-title"
            className="m-0 text-label font-medium text-text-muted"
          >
            Definitions Repository
          </h2>
          <ul
            role="list"
            aria-label="Definitions Repository"
            className={cn('m-0 list-none p-0', GRID)}
          >
            <ProjectCard project={definitions} now={now} Heading="h3" />
          </ul>
        </section>
      ) : null}
      {empty ?? (
        <ul role="list" aria-label="Projects" className={cn('m-0 list-none p-0', GRID)}>
          {ordinary.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              now={now}
              previewState={previews?.previews.find((p) => p.projectId === project.id)?.state}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/** One project's card: the whole card opens the project (the link's ::after covers it). */
function ProjectCard({
  project,
  now,
  previewState,
  Heading = 'h2',
}: {
  project: ProjectOutput;
  now: number;
  previewState?: string;
  /** One level below the heading the card sits under. */
  Heading?: 'h2' | 'h3';
}) {
  const createdAt = new Date(project.createdAt);
  return (
    <li className="min-w-0">
      <Card className="relative h-full gap-1.5 p-4 transition-colors hover:bg-hover has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring">
        <Heading className="m-0 truncate text-body font-semibold">
          <Link
            href={`/projects/${project.id}`}
            className="text-text no-underline outline-none after:absolute after:inset-0 after:rounded-lg after:content-['']"
          >
            {project.name}
          </Link>
        </Heading>
        {project.kind === 'definitions' ? (
          <div>
            <Badge>Definitions Repository</Badge>
          </div>
        ) : (
          <PreviewBadge state={previewState} />
        )}
        <p className="m-0 text-caption text-text-dim">
          Created{' '}
          <time dateTime={project.createdAt} title={formatExactTime(createdAt)}>
            {formatTimeAgo(createdAt, now)}
          </time>
        </p>
      </Card>
    </li>
  );
}
