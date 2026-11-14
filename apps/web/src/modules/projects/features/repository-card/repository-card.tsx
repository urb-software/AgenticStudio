'use client';

import {
  DownloadIcon,
  GitBranchIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  UnplugIcon,
} from 'lucide-react';
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Banner } from '@/shared/components/banner';
import { CopyButton } from '@/shared/components/copy-button';
import { EmptyState } from '@/shared/components/empty-state';
import { StatusPill } from '@/shared/components/status-pill';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { toast } from '@/shared/ui/sonner';
import {
  ApiError,
  type RepositoryOutput,
  type RepositoryStateOutput,
  type RepositorySummaryOutput,
} from '../../../../platform/api';
import {
  useConnectRepository,
  useFetchRepository,
  useForgetRepository,
  useRefreshProject,
  useRepository,
  useVerifyRepository,
} from '../../api/projects-queries';
import { formatExactTime, formatTimeAgo } from '../../components/relative-time';
import { ConnectRepositoryDialog } from '../connect-repository/connect-repository-dialog';
import {
  DISCONNECTED_MESSAGE,
  DisconnectRepositoryDialog,
  disconnectedToastId,
} from '../disconnect-repository/disconnect-repository-dialog';
import { failureMessage, gitOutputOf, type Transport } from './failure-message';

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

/**
 * SSH Repositories (Issue #62) carry the Deploy key's public half; HTTPS ones do not. The API
 * exposes neither the transport nor the host (#72), so the card derives them here.
 */
function transportOf(repository: RepositoryOutput): Transport {
  return repository.publicKey === undefined ? 'https' : 'ssh';
}

/** The Git host of an SSH URL as the operator wrote it (`host` or `host:port`). */
function hostOf(url: string): string {
  const scp = /^[^@/:\s]+@([^@/:\s]+):/.exec(url);
  if (scp && !url.includes('://')) return scp[1]!;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The comment of a public key line: its last field (`studio-<project name>`). */
function keyComment(publicKey: string): string | undefined {
  const fields = publicKey.trim().split(/\s+/);
  return fields.length > 2 ? fields.at(-1) : undefined;
}

/**
 * The Deploy key's public half (Issue #62) in mono, scrolling inside its own box (one long
 * line), with a Copy button and the instruction. The private half never reaches the browser.
 */
function PublicKey({ publicKey }: { publicKey: string }) {
  const comment = keyComment(publicKey);
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-body">
        Add this as a deploy key on your Git host. Read access is enough for now.
      </p>
      <div className="flex min-w-0 items-start gap-2">
        <pre
          aria-label="Public key"
          tabIndex={0}
          className="m-0 min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-bg-subtle px-3 py-2 text-code whitespace-pre text-text"
        >
          {publicKey}
        </pre>
        <CopyButton value={publicKey} label="Copy public key" className="shrink-0" />
      </div>
      {comment ? (
        <p className="m-0 text-small text-text-muted">
          Key comment: <code className="text-code">{comment}</code>
        </p>
      ) : null}
    </div>
  );
}

type VerifyMutation = ReturnType<typeof useVerifyRepository>;

/** The API's refusal of a verify (e.g. 409, 501) as a banner; field errors are shown inline. */
function VerifyError({ verify }: { verify: VerifyMutation }) {
  if (!verify.error) return null;
  const problem = verify.error instanceof ApiError ? verify.error.problem : undefined;
  if (problem?.errors?.some((error) => error.path === 'acceptHostKeyFingerprint')) return null;
  return (
    <Banner tone="danger" title={problem?.title}>
      {problem?.detail || 'Could not verify the repository. Try again.'}
    </Banner>
  );
}

/** `awaiting_key`: the Deploy key to add on the Git host, then "Verify and clone". */
function AwaitingKeyBody({
  repository,
  verify,
}: {
  repository: RepositoryOutput;
  verify: VerifyMutation;
}) {
  return (
    <div className="flex flex-col gap-4">
      <PublicKey publicKey={repository.publicKey ?? ''} />
      <Details>
        <Target repository={repository} />
      </Details>
      <VerifyError verify={verify} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          icon={ShieldCheckIcon}
          loading={verify.isPending}
          onClick={() => verify.mutate({})}
        >
          {verify.isPending ? 'Verifying…' : 'Verify and clone'}
        </Button>
      </div>
    </div>
  );
}

/**
 * `awaiting_host_key`: the Git host is not trusted yet. Shows the host and its SHA256
 * fingerprint in mono and asks for an explicit confirmation. Cancel only closes the question
 * here (nothing is trusted); "Verify and clone" retrieves the host key again.
 */
function AwaitingHostKeyBody({
  repository,
  verify,
}: {
  repository: RepositoryOutput;
  verify: VerifyMutation;
}) {
  const [cancelled, setCancelled] = useState(false);
  const fingerprint = repository.hostKeyFingerprint ?? '';
  const problem = verify.error instanceof ApiError ? verify.error.problem : undefined;
  const mismatch = problem?.errors?.find((error) => error.path === 'acceptHostKeyFingerprint');
  return (
    <div className="flex flex-col gap-4">
      {cancelled ? (
        <p role="status" className="m-0 text-body text-text-muted">
          Host key not confirmed. Studio connects to this host only after you confirm its key.
        </p>
      ) : (
        <section
          aria-labelledby="host-key-title"
          className="flex flex-col gap-3 rounded-md border border-border bg-bg-subtle p-4"
        >
          <h3 id="host-key-title" className="m-0 text-body font-medium">
            Confirm the Git host&apos;s key
          </h3>
          <p className="m-0 text-body text-text-muted">
            Studio has not connected to this host before. Compare the fingerprint with the one your
            Git host publishes, and confirm only if they match.
          </p>
          <Details>
            <Detail term="Host">
              <code className="text-code break-all">{hostOf(repository.url)}</code>
            </Detail>
            <Detail term="Fingerprint">
              <code className="text-code break-all">{fingerprint}</code>
            </Detail>
          </Details>
          {mismatch ? (
            <Banner tone="danger" title="Fingerprint changed.">
              {mismatch.message}
            </Banner>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              icon={ShieldCheckIcon}
              loading={verify.isPending}
              onClick={() => verify.mutate({ acceptHostKeyFingerprint: fingerprint })}
            >
              {verify.isPending ? 'Confirming…' : 'Confirm and clone'}
            </Button>
            <Button disabled={verify.isPending} onClick={() => setCancelled(true)}>
              Cancel
            </Button>
          </div>
        </section>
      )}
      <VerifyError verify={verify} />
      {cancelled ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            icon={ShieldCheckIcon}
            loading={verify.isPending}
            onClick={() => {
              setCancelled(false);
              verify.mutate({});
            }}
          >
            Verify and clone
          </Button>
        </div>
      ) : null}
      <PublicKey publicKey={repository.publicKey ?? ''} />
      <Details>
        <Target repository={repository} />
      </Details>
    </div>
  );
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
          ? failureMessage(failure, repository.integrationBranch, 'fetch', transportOf(repository))
          : 'The fetch failed.'}
      </Banner>
      {failure ? <GitOutput failure={failure} /> : null}
      <CloneDetails repository={repository} now={now} />
      <FetchAction fetch={fetch} busy={false} variant="primary">
        <Button icon={PencilIcon} disabled={fetch.isPending} onClick={onChangeSettings}>
          Change settings
        </Button>
      </FetchAction>
    </div>
  );
}

/** The redacted Git output of a failure, if it has any. */
function GitOutput({ failure }: { failure: NonNullable<RepositoryOutput['failure']> }) {
  const detail = gitOutputOf(failure);
  if (!detail) return null;
  return (
    <pre
      aria-label="Git output"
      className="m-0 max-h-48 overflow-auto rounded-md border border-border bg-bg-subtle px-3 py-2 text-code break-all whitespace-pre-wrap text-text-muted"
    >
      {detail}
    </pre>
  );
}

/**
 * `failed` with no usable Clone (a failed connect, or a fetch that hit the size limit). Retry
 * connects again over HTTPS; over SSH it verifies again with the same Deploy key (#62), which
 * stays on screen so it can be added on the Git host.
 */
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
  const reconnect = useConnectRepository(projectId);
  const verify = useVerifyRepository(projectId);
  const transport = transportOf(repository);
  const retry = transport === 'ssh' ? verify : reconnect;
  const failure = repository.failure;
  const retryProblem = retry.error instanceof ApiError ? retry.error.problem : undefined;

  return (
    <div className="flex flex-col gap-4">
      {/* A connect or a fetch can hit the size limit, so its title names neither. */}
      <Banner
        tone="danger"
        title={failure?.code === 'size_limit' ? 'Repository too large.' : 'Clone failed.'}
      >
        {failure
          ? failureMessage(failure, repository.integrationBranch, 'clone', transport)
          : 'The clone failed.'}
      </Banner>
      {failure ? <GitOutput failure={failure} /> : null}
      {repository.publicKey !== undefined ? <PublicKey publicKey={repository.publicKey} /> : null}
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
            transport === 'ssh'
              ? verify.mutate({})
              : reconnect.mutate({
                  url: repository.url,
                  integrationBranch: repository.integrationBranch,
                })
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

/** A state this version does not know (added by a later API). */
function UnavailableBody({ repository }: { repository: RepositorySummaryOutput }) {
  return (
    <div className="flex flex-col gap-4">
      <Banner tone="warning" title="Repository unavailable.">
        This version of Studio does not know the repository&apos;s current state. Reload the page to
        get the latest version.
      </Banner>
      <Details>
        <Target repository={repository} />
      </Details>
    </div>
  );
}

/** What a state's body gets from the card. */
type StateBodyProps = {
  projectId: string;
  repository: RepositoryOutput;
  /** When the Repository was last read, for "Last fetched". */
  now: number;
  fetch: FetchMutation;
  verify: VerifyMutation;
  /** Opens the Connect dialog prefilled with the Repository's settings. */
  onChangeSettings: () => void;
};

/** How the card shows one state: the header pill (design system state tokens) and the body. */
type StateView = {
  pill: { status: ComponentProps<typeof StatusPill>['status']; label: string };
  body: (props: StateBodyProps) => ReactNode;
};

/**
 * Every state the card knows, in one place (#72): a state the API adds must be added here, and
 * any other value is shown as {@link UNAVAILABLE}.
 */
const STATE_VIEWS: Record<RepositoryStateOutput, StateView> = {
  awaiting_key: {
    pill: { status: 'awaiting', label: 'Awaiting key' },
    body: ({ repository, verify }) => <AwaitingKeyBody repository={repository} verify={verify} />,
  },
  awaiting_host_key: {
    pill: { status: 'awaiting', label: 'Confirm host' },
    body: ({ repository, verify }) => (
      <AwaitingHostKeyBody
        key={repository.hostKeyFingerprint}
        repository={repository}
        verify={verify}
      />
    ),
  },
  connecting: {
    pill: { status: 'running', label: 'Connecting' },
    body: ({ repository, fetch }) => <ConnectingBody repository={repository} fetch={fetch} />,
  },
  ready: {
    pill: { status: 'succeeded', label: 'Connected' },
    body: ({ repository, now, fetch }) => (
      <CloneBody repository={repository} now={now} fetch={fetch} />
    ),
  },
  fetching: {
    pill: { status: 'running', label: 'Fetching' },
    body: ({ repository, now, fetch }) => (
      <CloneBody repository={repository} now={now} fetch={fetch} />
    ),
  },
  failed: {
    pill: { status: 'failed', label: 'Failed' },
    body: ({ projectId, repository, now, fetch, onChangeSettings }) =>
      repository.hasClone ? (
        <FailedFetchBody
          repository={repository}
          now={now}
          fetch={fetch}
          onChangeSettings={onChangeSettings}
        />
      ) : (
        <FailedBody
          projectId={projectId}
          repository={repository}
          onChangeSettings={onChangeSettings}
        />
      ),
  },
  disconnecting: {
    pill: { status: 'running', label: 'Disconnecting' },
    body: ({ repository }) => <DisconnectingBody repository={repository} />,
  },
};

const UNAVAILABLE: StateView = {
  pill: { status: 'none', label: 'Unavailable' },
  body: ({ repository }) => <UnavailableBody repository={repository} />,
};

/** The view of a state, or {@link UNAVAILABLE} for one this version does not know. */
function viewOf(state: string): StateView {
  return Object.hasOwn(STATE_VIEWS, state)
    ? STATE_VIEWS[state as RepositoryStateOutput]
    : UNAVAILABLE;
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
 * The project's one Repository card, in every state: none (connect), awaiting_key (the Deploy
 * key to add, Verify and clone), awaiting_host_key (confirm the host's fingerprint), connecting (progress,
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
  const verifyRepository = useVerifyRepository(projectId);
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

  // One confirmation per disconnect: the dialog's 204 and this card's polling can both see the
  // same disconnect, and the later one can land after the first toast was dismissed (#72). A
  // Repository seen again (not gone) starts a new disconnect.
  const disconnectConfirmed = useRef(false);
  useEffect(() => {
    if (repository && !gone) disconnectConfirmed.current = false;
  }, [repository, gone]);
  const confirmDisconnected = useCallback(() => {
    if (disconnectConfirmed.current) return;
    disconnectConfirmed.current = true;
    toast.success(DISCONNECTED_MESSAGE, { id: disconnectedToastId(projectId) });
  }, [projectId]);
  // Once per disappearance, however often the card re-renders before the cache is updated.
  const goneHandled = useRef(false);
  useEffect(() => {
    if (!gone) {
      goneHandled.current = false;
      return;
    }
    if (goneHandled.current) return;
    goneHandled.current = true;
    confirmDisconnected();
    void forgetRepository();
  }, [gone, forgetRepository, confirmDisconnected]);

  let body: ReactNode;
  if (summary === null) {
    body = (
      <EmptyState
        icon={GitBranchIcon}
        title="No repository connected"
        description="Connect a public Git repository over HTTPS, or a private one over SSH with a deploy key Studio generates. Studio keeps its own clone, which agents later work from."
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
  } else {
    body = viewOf(repository.state).body({
      projectId,
      repository,
      now: repositoryQuery.dataUpdatedAt,
      fetch: fetchRepository,
      verify: verifyRepository,
      onChangeSettings: () => openConnect(repository),
    });
  }
  const pill = state ? viewOf(state).pill : undefined;

  return (
    <>
      <Card aria-labelledby={TITLE_ID}>
        <CardHeader>
          <CardTitle id={TITLE_ID}>Repository</CardTitle>
          {pill ? <StatusPill status={pill.status}>{pill.label}</StatusPill> : null}
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
        onDisconnected={confirmDisconnected}
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
