'use client';

import { BotIcon, PlusIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { Banner } from '@/shared/components/banner';
import { EmptyState } from '@/shared/components/empty-state';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { toast } from '@/shared/ui/sonner';
import { ApiError } from '../../../../platform/api';
import { ProjectRepository } from '../../../projects';
import { useCreateDefinitionsProject, useDefinitionsRepository } from '../../api/agents-queries';

/** The request the page makes (generated `getDefinitionsRepository`), shown verbatim on failure. */
const READ_REQUEST = 'GET /api/agents/definitions-repository';

function readRequestOf(error: unknown): string {
  if (!(error instanceof ApiError) || error.status === 0) return READ_REQUEST;
  const status = [error.status, error.problem?.title].filter(Boolean).join(' ');
  return `${READ_REQUEST} · ${status}`;
}

function LoadingAgents() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading the definitions Repository"
      className="flex flex-col gap-3"
    >
      <Skeleton className="h-3.5 w-64 max-w-full" />
      <Skeleton className="h-3.5 w-40" />
    </div>
  );
}

/** Nothing connected: one action that creates the definitions Project. */
function NotConnected() {
  const create = useCreateDefinitionsProject();
  const problem = create.error instanceof ApiError ? create.error.problem : undefined;
  return (
    <div className="flex flex-col gap-4">
      {create.error ? (
        <Banner tone="danger" title={problem?.title}>
          {problem?.detail || 'Could not create the definitions Repository. Try again.'}
        </Banner>
      ) : null}
      <EmptyState
        icon={BotIcon}
        title="No definitions Repository connected"
        description="Agents and skills are files in one Git repository. Connect it, and Studio keeps its own clone to read them from. It appears in Projects, apart from your other projects."
        action={
          <Button
            variant="primary"
            icon={PlusIcon}
            loading={create.isPending}
            onClick={() =>
              create.mutate(undefined, {
                onSuccess: () => toast.success('Definitions Repository created'),
              })
            }
          >
            {create.isPending ? 'Connecting…' : 'Connect definitions Repository'}
          </Button>
        }
      />
    </div>
  );
}

/**
 * The Agents screen. Without a definitions Repository it offers to connect one; with one it shows
 * the connection (state, Integration branch, last fetched commit, Fetch) through the existing
 * Repository card, so the connection steps are the ones every Project has.
 */
export function AgentsOverview() {
  const { data, error, isPending, isError, isRefetching, refetch } = useDefinitionsRepository();

  let body;
  if (isPending) {
    body = <LoadingAgents />;
  } else if (isError) {
    body = (
      <EmptyState
        tone="error"
        icon={TriangleAlertIcon}
        title="Couldn't load the definitions Repository"
        description={<span className="font-mono text-small">{readRequestOf(error)}</span>}
        action={
          <Button icon={RefreshCwIcon} loading={isRefetching} onClick={() => void refetch()}>
            Retry
          </Button>
        }
      />
    );
  } else if (data.project === null) {
    body = <NotConnected />;
  } else {
    body = <ProjectRepository projectId={data.project.id} />;
  }

  return (
    <>
      <h1 className="m-0 text-page-title font-semibold tracking-[-0.015em]">Agents</h1>
      {body}
    </>
  );
}
