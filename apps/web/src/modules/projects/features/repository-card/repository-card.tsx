'use client';

import {
  DownloadIcon,
  GitBranchIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  UnplugIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { EmptyState } from '@/shared/components/empty-state';
import { StatusPill } from '@/shared/components/status-pill';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { toast } from '@/shared/ui/sonner';
import {
  ApiError,
  type RepositoryOutput,
  type RepositorySummaryOutput,
} from '../../../../platform/api';
import {
  useConnectRepository,
  useFetchRepository,
  useForgetRepository,
  useRefreshProject,
  useRepository,
} from '../../api/projects-queries';
import { formatExactTime, formatTimeAgo } from '../../components/relative-time';
import { ConnectRepositoryDialog } from '../connect-repository/connect-repository-dialog';
import { DisconnectRepositoryDialog } from '../disconnect-repository/disconnect-repository-dialog';
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
    case 'fetching':
      return <StatusPill status="running">Fetching</StatusPill>;
    case 'failed':
      return <StatusPill status="failed">Failed</StatusPill>;
    case 'disconnecting':
      return <StatusPill status="running">Disconnecting</StatusPill>;
    default:
      return <StatusPill status="none">Unavailable</StatusPill>;
  }
}

type FetchMutation = ReturnType<typeof useFetchRepository>;

/**
 * The Fetch action and, above it, the API's refusal (e.g. 409) as a banner. It is disabled
 * while a connect or fetch runs (`busy`) and while the request is on its way.
 */
function FetchAction({
  fetch,
  busy,
  variant = 'secondary',
  children,
}: {
  fetch: FetchMutation;
  busy: boolean;
  variant?: 'primary' | 'secondary';
  /** Further actions next to Fetch. */
  children?: ReactNode;
}) {
  const problem = fetch.error instanceof ApiError ? fetch.error.problem : undefined;
  const fetching = busy || fetch.isPending;
  return (
    <>
      {fetch.error && !busy ? (
        <Banner tone="danger" title={problem?.title}>
          {problem?.detail || 'Could not start the fetch. Try again.'}
        </Banner>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={variant}
          icon={DownloadIcon}
          loading={fetch.isPending}
          disabled={fetching}
          onClick={() => fetch.mutate()}
        >
          {fetching ? 'Fetching…' : 'Fetch'}
        </Button>
        {children}
      </div>
    </>
  );
}

function ConnectingBody({
  repository,
  fetch,
}: {
  repository: RepositorySummaryOutput;
  fetch: FetchMutation;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="m-0 text-body text-text-muted">
        Cloning the repository. This can take a few minutes; you can leave this page.
      </p>
      <Details>
        <Target repository={repository} />
      </Details>
      <FetchAction fetch={fetch} busy />
    </div>
  );
}

/** `ready` or `fetching`: the Clone's commit and fetch time, and the Fetch action. */
function CloneBody({
  repository,
  now,
  fetch,
}: {
  repository: RepositoryOutput;
  now: number;
  fetch: FetchMutation;
}) {
  const fetching = repository.state === 'fetching';
  return (
    <div className="flex flex-col gap-4">
      {fetching ? (
        <p role="status" className="m-0 text-body text-text-muted">
          Fetching {repository.integrationBranch} from the remote. You can leave this page.
        </p>
      ) : null}
      <CloneDetails repository={repository} now={now} />
      <FetchAction fetch={fetch} busy={fetching} />
    </div>
  );
}

/** URL, branch, the Clone's HEAD commit and Last fetched. */
function CloneDetails({ repository, now }: { repository: RepositoryOutput; now: number }) {
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

/** `failed` after a fetch that kept the Clone: the previous data stays, and Fetch again. */
function FailedFetchBody({
  repository,
  now,
  fetch,
  onChangeSettings,
}: {
  repository: RepositoryOutput;
  now: number;
  fetch: FetchMutation;
  /** Opens the Connect dialog prefilled, e.g. to use another branch (branch_not_found). */
  onChangeSettings: () => void;
}) {
  const failure = repository.failure;
  return (
    <div className="flex flex-col gap-4">
      <Banner tone="danger" title="Fetch failed.">
        {failure
          ? failureMessage(failure, repository.integrationBranch, 'fetch')
          : 'The fetch failed.'}
      </Banner>
      {failure?.detail ? <GitOutput detail={failure.detail} /> : null}
      <CloneDetails repository={repository} now={now} />
      <FetchAction fetch={fetch} busy={false} variant="primary">
        <Button icon={PencilIcon} disabled={fetch.isPending} onClick={onChangeSettings}>
          Change settings
        </Button>
      </FetchAction>
    </div>
  );
}

/** The redacted Git output of a failure. */
function GitOutput({ detail }: { detail: string }) {
  return (
    <pre
      aria-label="Git output"
      className="m-0 max-h-48 overflow-auto rounded-md border border-border bg-bg-subtle px-3 py-2 text-code break-all whitespace-pre-wrap text-text-muted"
    >
      {detail}
    </pre>
  );
}

/** `failed` with no usable Clone (a failed connect, or a fetch that hit the size limit). */
function FailedBody({
  projectId,
  repository,
  onChangeSettings,
}: {
  projectId: string;
  repository: RepositoryOutput;
  /** Opens the Connect dialog prefilled, to fix the URL or the branch (e.g. branch_not_found). */
  onChangeSettings: () => void;
}) {
  const retry = useConnectRepository(projectId);
  const failure = repository.failure;
  const retryProblem = retry.error instanceof ApiError ? retry.error.problem : undefined;

  return (
    <div className="flex flex-col gap-4">
      <Banner tone="danger" title="Clone failed.">
        {failure ? failureMessage(failure, repository.integrationBranch) : 'The clone failed.'}
      </Banner>
      {failure?.detail ? <GitOutput detail={failure.detail} /> : null}
      <Details>
        <Target repository={repository} />
      </Details>
      {retry.error ? (
        <Banner tone="danger" title={retryProblem?.title}>
          {retryProblem?.detail || 'Could not retry. Try again.'}
        </Banner>
      ) : null}
      <div className="flex flex-wrap gap-2">
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
        <Button icon={PencilIcon} disabled={retry.isPending} onClick={onChangeSettings}>
          Change settings
        </Button>
      </div>
    </div>
  );
}

/** `disconnecting`: the server is still removing Studio's data; it retries on its own. */
function DisconnectingBody({ repository }: { repository: RepositorySummaryOutput }) {
  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="m-0 text-body text-text-muted">
        <strong className="font-medium text-text">Disconnecting…</strong> Removing Studio&apos;s
        copy of the repository. Studio keeps trying on its own; Disconnect tries again now.
      </p>
      <Details>
        <Target repository={repository} />
      </Details>
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
 * polled), ready (Fetch), fetching (progress, polled), failed with a usable Clone (the
 * previous data, Fetch again), failed without one (message, redacted detail, Retry),
 * disconnecting (progress, polled) and any state a later API adds ("unavailable"). Every state
 * but none offers Disconnect (#63). The state always comes from the server.
 */
export function RepositoryCard({ projectId, summary }: RepositoryCardProps) {
  const [connectOpen, setConnectOpen] = useState(false);
  // Remounts the dialog per opening, so it starts from the right values (empty or prefilled).
  const [dialogKey, setDialogKey] = useState(0);
  const [prefill, setPrefill] = useState<RepositorySummaryOutput | undefined>();
  const openConnect = (values?: RepositorySummaryOutput) => {
    setPrefill(values);
    setDialogKey((key) => key + 1);
    setConnectOpen(true);
  };
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const repositoryQuery = useRepository(projectId, summary !== null);
  const refreshProject = useRefreshProject(projectId);
  const forgetRepository = useForgetRepository(projectId);
  const fetchRepository = useFetchRepository(projectId);
  const repository = repositoryQuery.data;
  const state = repository?.state ?? summary?.state;

  // When polling sees the Repository leave a state, the project's summary is refreshed too,
  // and a fetch that ended well is confirmed with a toast (#61 clarification 7).
  const last = useRef(repository);
  useEffect(() => {
    const previous = last.current;
    if (repository && previous && previous.state !== repository.state) {
      void refreshProject();
      if (previous.state === 'fetching' && repository.state === 'ready') {
        toast.success(
          repository.headSha && repository.headSha !== previous.headSha
            ? `Fetched ${repository.integrationBranch} · ${shortSha(repository.headSha)}`
            : 'Already up to date',
        );
      }
    }
    last.current = repository;
  }, [repository, refreshProject]);

  // A disconnecting Repository that polling no longer finds (404) is gone: the server's
  // cleanup finished. Confirm it and show the empty state (#63 clarification 8).
  const gone =
    repositoryQuery.error instanceof ApiError &&
    repositoryQuery.error.status === 404 &&
    repository?.state === 'disconnecting';
  // Once per disappearance, however often the card re-renders before the cache is updated.
  const goneHandled = useRef(false);
  useEffect(() => {
    if (!gone) {
      goneHandled.current = false;
      return;
    }
    if (goneHandled.current) return;
    goneHandled.current = true;
    toast.success('Repository disconnected');
    void forgetRepository();
  }, [gone, forgetRepository]);

  let body: ReactNode;
  if (summary === null) {
    body = (
      <EmptyState
        icon={GitBranchIcon}
        title="No repository connected"
        description="Connect a public Git repository over HTTPS. Studio keeps its own clone, which agents later work from."
        action={
          <Button variant="primary" icon={PlusIcon} onClick={() => openConnect()}>
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
    body = <ConnectingBody repository={repository} fetch={fetchRepository} />;
  } else if (repository.state === 'ready' || repository.state === 'fetching') {
    body = (
      <CloneBody
        repository={repository}
        now={repositoryQuery.dataUpdatedAt}
        fetch={fetchRepository}
      />
    );
  } else if (repository.state === 'failed' && repository.hasClone) {
    body = (
      <FailedFetchBody
        repository={repository}
        now={repositoryQuery.dataUpdatedAt}
        fetch={fetchRepository}
        onChangeSettings={() => openConnect(repository)}
      />
    );
  } else if (repository.state === 'failed') {
    body = (
      <FailedBody
        projectId={projectId}
        repository={repository}
        onChangeSettings={() => openConnect(repository)}
      />
    );
  } else if (repository.state === 'disconnecting') {
    body = <DisconnectingBody repository={repository} />;
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
        <CardContent>
          {summary === null ? (
            body
          ) : (
            <div className="flex flex-col gap-4">
              {body}
              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                <Button variant="danger" icon={UnplugIcon} onClick={() => setDisconnectOpen(true)}>
                  Disconnect
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      {/* Mounted in every state, so it can close itself once the Repository is gone. */}
      <DisconnectRepositoryDialog
        projectId={projectId}
        url={repository?.url ?? summary?.url ?? ''}
        open={disconnectOpen && summary !== null}
        onOpenChange={setDisconnectOpen}
      />
      <ConnectRepositoryDialog
        key={dialogKey}
        projectId={projectId}
        initialValues={
          prefill && { url: prefill.url, integrationBranch: prefill.integrationBranch }
        }
        open={connectOpen}
        onOpenChange={setConnectOpen}
      />
    </>
  );
}
