'use client';

import { type FormEvent, useCallback, useState } from 'react';
import Link from 'next/link';
import { BotIcon, PlusIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { Banner } from '@/shared/components/banner';
import { EmptyState } from '@/shared/components/empty-state';
import { Button } from '@/shared/ui/button';
import { TextField } from '@/shared/components/text-field';
import { Skeleton } from '@/shared/ui/skeleton';
import { toast } from '@/shared/ui/sonner';
import { ApiError, createProjectRequestHint } from '../../../../platform/api';
import { ProjectRepository } from '../../../projects';
import {
  DEFINITIONS_PROJECT_NAME,
  nameProblemOf,
  useCreateDefinitionsProject,
  useDefinitionsRepository,
  useRefreshAgents,
} from '../../api/agents-queries';
import { AgentList } from '../agent-list/agent-list';

/** The request the page makes (generated `getDefinitionsRepository`), shown verbatim on failure. */
const READ_REQUEST = 'GET /api/agents/definitions-repository';

function readRequestOf(error: unknown): string {
  if (!(error instanceof ApiError) || error.status === 0) return READ_REQUEST;
  const status = [error.status, error.problem?.title].filter(Boolean).join(' ');
  return `${READ_REQUEST} · ${status}`;
}

/** A form hint only (the API stays authoritative): blank, or longer than the API's limit. */
function nameHintError(name: string): string | undefined {
  // The API measures the name after trimming and collapsing whitespace, in code points.
  const normalized = name.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const parsed = createProjectRequestHint.shape.name.safeParse(normalized);
  if (parsed.success) return undefined;
  return normalized === '' ? 'Enter a project name.' : 'Use at most 100 characters.';
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
function NotConnected({ onCreated }: { onCreated: () => void }) {
  const create = useCreateDefinitionsProject();
  const [name, setName] = useState(DEFINITIONS_PROJECT_NAME);
  const problem = create.error instanceof ApiError ? create.error.problem : undefined;
  const [hintError, setHintError] = useState<string>();
  // A name problem is the operator's to change; only other failures are banners.
  const nameProblem = hintError ?? nameProblemOf(create.error);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const invalid = nameHintError(name);
    setHintError(invalid);
    if (invalid) return;
    create.mutate(name, {
      onSuccess: () => {
        onCreated();
        toast.success('Definitions Repository added. Connect it next.');
      },
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {create.error && nameProblemOf(create.error) === undefined ? (
        <Banner tone="danger" title={problem?.title}>
          {problem?.detail || 'Could not create the definitions Repository. Try again.'}
        </Banner>
      ) : null}
      {nameProblem ? (
        <form onSubmit={submit} noValidate className="flex max-w-md flex-col gap-3">
          <TextField
            label="Project name"
            autoComplete="off"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setHintError(undefined);
            }}
            error={nameProblem}
            autoFocus
            readOnly={create.isPending}
          />
          <div>
            <Button type="submit" variant="primary" loading={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </form>
      ) : (
        <EmptyState
          icon={BotIcon}
          title="No definitions Repository connected"
          description="Agents and skills are files in one Git repository. Connect it, and Studio keeps its own clone to read them from. It appears in Projects, apart from your other projects."
          action={
            <Button
              variant="primary"
              icon={PlusIcon}
              loading={create.isPending}
              onClick={() => submit()}
            >
              {create.isPending ? 'Creating…' : 'Connect definitions Repository'}
            </Button>
          }
        />
      )}
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
  // Set when the Project was just created here: the card's first step takes the focus.
  const [justCreated, setJustCreated] = useState(false);
  // A Repository that changed (first clone, fetch, failure, disconnect) changes the agents.
  const refreshAgents = useRefreshAgents();
  const onRepositoryChanged = useCallback(() => void refreshAgents(), [refreshAgents]);

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
    body = (
      <>
        <NotConnected onCreated={() => setJustCreated(true)} />
        {/* The built-in agents and the base rules exist without a Repository. */}
        <AgentList />
      </>
    );
  } else {
    // The card reads the Project itself: it needs the URL and shares the Project's cache entries,
    // which the connect, fetch and disconnect steps keep current. This answer only names it.
    body = (
      <>
        <ProjectRepository
          projectId={data.project.id}
          autoFocusConnect={justCreated}
          onRepositoryChanged={onRepositoryChanged}
        />
        <AgentList />
      </>
    );
  }

  return (
    <>
      <h1 className="m-0 text-page-title font-semibold tracking-[-0.015em]">Agents</h1>
      <p className="m-0 text-small text-text-muted">
        Skills are read from the same Repository.{' '}
        <Link href="/agents/skills">See the skills and whether each is valid</Link>.
      </p>
      {body}
    </>
  );
}
