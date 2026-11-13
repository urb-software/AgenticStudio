'use client';

import { GitBranchIcon, PlusIcon, RefreshCwIcon } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { EmptyState } from '@/shared/components/empty-state';
import { StatusPill } from '@/shared/components/status-pill';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import {
  ApiError,
  type RepositoryOutput,
  type RepositorySummaryOutput,
} from '../../../../platform/api';
import { useConnectRepository, useRefreshProject, useRepository } from '../../api/projects-queries';
import { formatExactTime, formatTimeAgo } from '../../components/relative-time';
import { ConnectRepositoryDialog } from '../connect-repository/connect-repository-dialog';
import { failureMessage } from './failure-message';

const TITLE_ID = 'repository-card-title';

/** The commit id as the card shows it: the first 7 hex digits, like Git's short form. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function Details({ children }: { children: ReactNode }) {
  return (
    <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 text-body md:grid-cols-[max-content_minmax(0,1fr)] md:gap-y-2.5">
      {children}
    </dl>
  );
}

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-small text-text-muted max-md:mt-2 max-md:first:mt-0">{term}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}

/** URL and Integration branch, the part every state shows. */
function Target({ repository }: { repository: RepositorySummaryOutput }) {
  return (
    <>
      <Detail term="Repository URL">
        <code className="text-code break-all">{repository.url}</code>
      </Detail>
      <Detail term="Integration branch">
        <code className="text-code break-all">{repository.integrationBranch}</code>
      </Detail>
    </>
  );
}

/** The header pill: the state in words, coloured by the design system's state tokens. */
function StatePill({ state }: { state: string }) {
  switch (state) {
    case 'connecting':
      return <StatusPill status="running">Connecting</StatusPill>;
    case 'ready':
      return <StatusPill status="succeeded">Connected</StatusPill>;
    case 'failed':
      return <StatusPill status="failed">Failed</StatusPill>;
    default:
      return <StatusPill status="none">Unavailable</StatusPill>;
  }
}

function ConnectingBody({ repository }: { repository: RepositorySummaryOutput }) {
  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="m-0 text-body text-text-muted">
        Cloning the repository. This can take a few minutes; you can leave this page.
      </p>
      <Details>
        <Target repository={repository} />
      </Details>
    </div>
  );
}

function ReadyBody({ repository, now }: { repository: RepositoryOutput; now: number }) {
  const fetchedAt = repository.lastFetchedAt ? new Date(repository.lastFetchedAt) : undefined;
  return (
    <Details>
      <Target repository={repository} />
      <Detail term="HEAD commit">
        {repository.headSha ? (
          <code className="text-code" title={repository.headSha}>
            {shortSha(repository.headSha)}
          </code>
        ) : (
          '—'
        )}
      </Detail>
      <Detail term="Last fetched">
        {fetchedAt ? (
          <time dateTime={repository.lastFetchedAt} title={formatExactTime(fetchedAt)}>
            {formatTimeAgo(fetchedAt, now)}
          </time>
        ) : (
          '—'
        )}
      </Detail>
    </Details>
  );
}

function FailedBody({
  projectId,
  repository,
}: {
  projectId: string;
  repository: RepositoryOutput;
}) {
  const retry = useConnectRepository(projectId);
  const failure = repository.failure;
  const retryProblem = retry.error instanceof ApiError ? retry.error.problem : undefined;

  return (
    <div className="flex flex-col gap-4">
      <Banner tone="danger" title="Clone failed.">
        {failure ? failureMessage(failure, repository.integrationBranch) : 'The clone failed.'}
      </Banner>
      {failure?.detail ? (
        <pre
          aria-label="Git output"
          className="m-0 max-h-48 overflow-auto rounded-md border border-border bg-bg-subtle px-3 py-2 text-code break-all whitespace-pre-wrap text-text-muted"
        >
          {failure.detail}
        </pre>
      ) : null}
      <Details>
        <Target repository={repository} />
      </Details>
      {retry.error ? (
        <Banner tone="danger" title={retryProblem?.title}>
          {retryProblem?.detail || 'Could not retry. Try again.'}
        </Banner>
      ) : null}
      <div>
        <Button
          variant="primary"
          icon={RefreshCwIcon}
          loading={retry.isPending}
          onClick={() =>
            retry.mutate({ url: repository.url, integrationBranch: repository.integrationBranch })
          }
        >
          {retry.isPending ? 'Retrying…' : 'Retry'}
        </Button>
      </div>
    </div>
  );
}

function LoadingBody() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading the repository"
      className="flex flex-col gap-3"
    >
      <Skeleton className="h-3.5 w-64 max-w-full" />
      <Skeleton className="h-3.5 w-40" />
    </div>
  );
}

type RepositoryCardProps = {
  projectId: string;
  /** From the project detail: whether a Repository exists, and its state when last read. */
  summary: RepositorySummaryOutput | null;
};

/**
 * The project's one Repository card, in every state: none (connect), connecting (progress,
 * polled), ready, failed (message, redacted detail, Retry) and any state a later API adds
 * ("unavailable"). The state always comes from the server.
 */
export function RepositoryCard({ projectId, summary }: RepositoryCardProps) {
  const [connectOpen, setConnectOpen] = useState(false);
  const repositoryQuery = useRepository(projectId, summary !== null);
  const refreshProject = useRefreshProject(projectId);
  const repository = repositoryQuery.data;
  const state = repository?.state ?? summary?.state;

  // When polling sees the Repository leave a state, the project's summary is refreshed too.
  const lastState = useRef(repository?.state);
  useEffect(() => {
    if (repository && lastState.current && lastState.current !== repository.state) {
      void refreshProject();
    }
    lastState.current = repository?.state;
  }, [repository, refreshProject]);

  let body: ReactNode;
  if (summary === null) {
    body = (
      <EmptyState
        icon={GitBranchIcon}
        title="No repository connected"
        description="Connect a public Git repository over HTTPS. Studio keeps its own clone, which agents later work from."
        action={
          <Button variant="primary" icon={PlusIcon} onClick={() => setConnectOpen(true)}>
            Connect repository
          </Button>
        }
      />
    );
  } else if (!repository) {
    body = repositoryQuery.isError ? (
      <Banner
        tone="danger"
        title="Couldn't load the repository."
        action={
          <Button size="sm" icon={RefreshCwIcon} onClick={() => void repositoryQuery.refetch()}>
            Retry
          </Button>
        }
      >
        Check the connection and try again.
      </Banner>
    ) : (
      <LoadingBody />
    );
  } else if (repository.state === 'connecting') {
    body = <ConnectingBody repository={repository} />;
  } else if (repository.state === 'ready') {
    body = <ReadyBody repository={repository} now={repositoryQuery.dataUpdatedAt} />;
  } else if (repository.state === 'failed') {
    body = <FailedBody projectId={projectId} repository={repository} />;
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <Banner tone="warning" title="Repository unavailable.">
          This version of Studio does not know the repository&apos;s current state. Reload the page
          to get the latest version.
        </Banner>
        <Details>
          <Target repository={repository} />
        </Details>
      </div>
    );
  }

  return (
    <>
      <Card aria-labelledby={TITLE_ID}>
        <CardHeader>
          <CardTitle id={TITLE_ID}>Repository</CardTitle>
          {state ? <StatePill state={state} /> : null}
        </CardHeader>
        <CardContent>{body}</CardContent>
      </Card>
      <ConnectRepositoryDialog
        projectId={projectId}
        open={connectOpen}
        onOpenChange={setConnectOpen}
      />
    </>
  );
}
