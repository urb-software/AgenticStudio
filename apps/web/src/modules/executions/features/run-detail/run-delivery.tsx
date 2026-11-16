'use client';

import { ExternalLinkIcon, GitBranchIcon, GitPullRequestIcon, RotateCwIcon } from 'lucide-react';
import { Banner } from '@/shared/components/banner';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import type { RunOutput } from '../../../../platform/api';
import { useProjectRuns, useRetryDelivery } from '../../api/runs-queries';
import { failedRequest } from '../../components/failed-request';
import { FINAL_STATES } from '../../components/run-states';

/** The request "Retry delivery" makes (generated `retryRunDelivery`), shown when it fails. */
const RETRY_REQUEST = 'POST /api/runs/{runId}/retry-delivery';

/** States in which nothing is pushed: the Run ended without a result to deliver. */
const NOT_DELIVERED: readonly RunOutput['state'][] = ['failed', 'cancelled', 'timed_out'];

/** A branch name or check name, verbatim in mono (design-system README: show the machine). */
function Mono({ children }: { children: string }) {
  return <code className="font-mono text-code break-all">{children}</code>;
}

/**
 * Whether `url` is a page on github.com over https (Issue #115). The worker protocol only
 * accepts such URLs; this keeps any other host from ever becoming a link on the Run page.
 */
function isGitHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'github.com' &&
      parsed.port === '' &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

/** The Run's draft pull request on GitHub, opened in a new tab; as text if not on github.com. */
function PullRequestLink({ pullRequest }: { pullRequest: { url: string; number: number } }) {
  if (!isGitHubUrl(pullRequest.url)) {
    return (
      <span className="inline-flex items-center gap-1">
        <GitPullRequestIcon aria-hidden="true" className="size-3.5" />
        Pull request #{pullRequest.number}
      </span>
    );
  }
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-brand no-underline hover:underline"
    >
      <GitPullRequestIcon aria-hidden="true" className="size-3.5" />
      Pull request #{pullRequest.number}
      <ExternalLinkIcon aria-hidden="true" className="size-3" />
      <span className="sr-only">(opens GitHub in a new tab)</span>
    </a>
  );
}

/** The checks the agent reported failed, said plainly (Issue #102). */
function FailingChecks({ run }: { run: RunOutput }) {
  const names = run.failingChecks ?? [];
  if (names.length === 0) return null;
  return (
    <Banner tone="warning" title="Some checks failed.">
      The agent reported {names.length === 1 ? 'this check' : 'these checks'} as failed:{' '}
      {names.map((name, index) => (
        <span key={`${index}-${name}`}>
          {index > 0 ? ', ' : null}
          <Mono>{name}</Mono>
        </span>
      ))}
      .{run.delivery === 'delivered' ? ' The pull request says so too.' : null}
    </Banner>
  );
}

/**
 * The reminder on the first delivery to a Repository (Issue #102): branch protection is what
 * keeps the Agent account away from the integration branch. Shown while no earlier Run of the
 * project was delivered.
 */
function FirstDeliveryReminder({ run }: { run: RunOutput }) {
  const { data } = useProjectRuns(run.projectId);
  if (!data) return null;
  const delivered = data.some(
    (other) =>
      other.id !== run.id &&
      other.delivery === 'delivered' &&
      Date.parse(other.createdAt) < Date.parse(run.createdAt),
  );
  if (delivered) return null;
  return (
    <Banner tone="warning" title="First delivery to this repository.">
      Check that branch protection on the integration branch keeps the Agent account from merging or
      pushing to it directly.
    </Banner>
  );
}

/** "Retry delivery": repeats only the delivery, without running the agent again. */
function RetryDelivery({ run }: { run: RunOutput }) {
  const retry = useRetryDelivery(run.id);
  if (run.deliveryRetryRequested) {
    return (
      <Banner tone="info" icon={RotateCwIcon} title="Retrying the delivery.">
        The agent worker pushes the Run branch and opens the pull request again; this page follows
        it.
      </Banner>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="m-0 text-small text-text-muted">
        {run.runBranch ? (
          <>
            The Run branch <Mono>{run.runBranch}</Mono> stays in the Working copy on the agent
            worker, so the delivery can be repeated without running the agent again.
          </>
        ) : (
          'The delivery can be repeated without running the agent again.'
        )}
      </p>
      <Button icon={RotateCwIcon} loading={retry.isPending} onClick={() => retry.mutate()}>
        Retry delivery
      </Button>
      {retry.isError ? (
        <Banner tone="danger" title="Couldn't retry the delivery.">
          <span className="font-mono text-small">{failedRequest(RETRY_REQUEST, retry.error)}</span>
        </Banner>
      ) : null}
    </div>
  );
}

/**
 * How the Run's result reached GitHub (Issue #102): the draft pull request, "No changes", a
 * failed delivery with "Retry delivery", failing checks, the first-delivery reminder, and where
 * the Run branch is when nothing was pushed.
 */
export function RunDelivery({ run }: { run: RunOutput }) {
  const deliveryFailed = run.failure?.code === 'delivery_failed';
  // Issue #141: the Run's one pull request, kept from an earlier delivery while a Follow-up
  // works on the Run, or after a Follow-up that ended without delivering.
  const keptPullRequest = run.delivery !== 'delivered' ? run.pullRequest : undefined;
  return (
    <>
      {keptPullRequest && FINAL_STATES.includes(run.state) ? (
        <Banner tone="info" icon={GitPullRequestIcon} title="This Follow-up pushed nothing.">
          <PullRequestLink pullRequest={keptPullRequest} /> from an earlier delivery stays as it
          was; the Follow-up&apos;s commits stay in the working copy.
        </Banner>
      ) : null}
      {keptPullRequest && !FINAL_STATES.includes(run.state) ? (
        <Banner
          tone="info"
          icon={GitPullRequestIcon}
          title="The Follow-up updates the draft pull request when it is done."
        >
          <PullRequestLink pullRequest={keptPullRequest} /> on GitHub.
        </Banner>
      ) : null}
      {run.state === 'cancelled' && run.delivery === 'delivered' && run.pullRequest ? (
        <Banner
          tone="warning"
          icon={GitPullRequestIcon}
          title="Cancelled during its delivery: a draft pull request was opened."
        >
          <PullRequestLink pullRequest={run.pullRequest} /> stays open on GitHub; close it there if
          it is not wanted.
        </Banner>
      ) : null}
      {run.state !== 'cancelled' && run.delivery === 'delivered' && run.pullRequest ? (
        <Banner tone="success" icon={GitPullRequestIcon} title="Draft pull request opened.">
          <PullRequestLink pullRequest={run.pullRequest} /> on GitHub
          {run.runBranch ? (
            <>
              , from the Run branch <Mono>{run.runBranch}</Mono>
            </>
          ) : null}
          .
        </Banner>
      ) : null}
      {run.delivery === 'none' && run.state === 'succeeded' && !run.pullRequest ? (
        <Banner tone="info" title="No changes.">
          The agent changed nothing, so nothing was pushed and no pull request was opened.
        </Banner>
      ) : null}
      {run.state === 'succeeded' || deliveryFailed ? <FailingChecks run={run} /> : null}
      {deliveryFailed ? <RetryDelivery run={run} /> : null}
      {run.delivery === 'delivered' || deliveryFailed ? <FirstDeliveryReminder run={run} /> : null}
      {NOT_DELIVERED.includes(run.state) &&
      !deliveryFailed &&
      !run.delivery &&
      !run.pullRequest &&
      run.runBranch ? (
        <Banner tone="info" icon={GitBranchIcon} title="Nothing was pushed.">
          The Run branch <Mono>{run.runBranch}</Mono> stays in the Working copy on the agent worker
          until retention removes it.
        </Banner>
      ) : null}
    </>
  );
}

/** A commit's short id, as Git shows it. */
const shortId = (id: string) => id.slice(0, 7);

/**
 * The Run branch's commits (Issue #141), oldest first: each says whether it is on the remote
 * Run branch (pushed) or exists only in the working copy on the agent worker, or that this is
 * unknown (review S5 of #150: the pushed commit is not among the listed ones). Plain text: the
 * subjects are the agent's.
 */
export function RunCommits({ run }: { run: RunOutput }) {
  const commits = run.commits ?? [];
  if (commits.length === 0) return null;
  return (
    <Card aria-labelledby="run-commits-title">
      <CardHeader>
        <CardTitle id="run-commits-title">Commits</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Commits">
          {commits.map((commit) => (
            <li
              key={commit.id}
              className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-small"
            >
              <code className="font-mono text-code text-text-muted" title={commit.id}>
                {shortId(commit.id)}
              </code>
              <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
                {commit.subject}
              </span>
              <span className="text-caption font-medium text-text-dim">
                {commit.pushed === undefined
                  ? 'Pushed state unknown'
                  : commit.pushed
                    ? 'Pushed'
                    : 'Only in the working copy'}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
