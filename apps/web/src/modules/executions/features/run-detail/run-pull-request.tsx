'use client';

import { ExternalLinkIcon, GitMergeIcon, RefreshCwIcon } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { StatusPill } from '@/shared/components/status-pill';
import { formatExactTime } from '@/shared/lib/relative-time';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import type { RunOutput } from '../../../../platform/api';
import { useRefreshPullRequest } from '../../api/runs-queries';
import { failedRequest } from '../../components/failed-request';
import { isGitHubPullRequestUrl } from '../../components/github-links';
import { PULL_REQUEST_STATE_VIEW, summarizeChecks } from '../../components/run-presentation';
import { BringUpToDateDialog } from '../bring-up-to-date/bring-up-to-date-dialog';
import { RunFailingChecks } from './run-failing-checks';
import { RunPullRequestChecks } from './run-pull-request-checks';

/** While a check is queued or running, the page reads the checks again this often (Issue #145). */
const CHECKS_REFRESH_MS = 30_000;

/** The request "Refresh" makes (generated `refreshRunPullRequest`), shown when it fails. */
const REFRESH_REQUEST = 'POST /api/runs/{runId}/pull-request/refresh';

type PullRequest = NonNullable<RunOutput['pullRequest']>;

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-caption font-medium text-text-dim">{term}</dt>
      <dd className="m-0 min-w-0 text-body">{children}</dd>
    </div>
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The pull request's number, linked to GitHub when it is a github.com page. */
function PullRequestNumber({ pullRequest }: { pullRequest: PullRequest }) {
  if (!isGitHubPullRequestUrl(pullRequest.url)) {
    return <span className="font-mono text-code">#{pullRequest.number}</span>;
  }
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-mono text-code text-brand no-underline hover:underline"
    >
      #{pullRequest.number}
      <ExternalLinkIcon aria-hidden="true" className="size-3" />
      <span className="sr-only">(opens GitHub in a new tab)</span>
    </a>
  );
}

/** How far the Run branch is from the integration branch, in words. */
function Position({ pullRequest }: { pullRequest: PullRequest }) {
  const { behindBy, aheadBy } = pullRequest;
  if (behindBy === undefined || aheadBy === undefined)
    return <span className="text-text-dim">—</span>;
  return (
    <span className="tabular-nums">
      {plural(behindBy, 'commit', 'commits')} behind · {plural(aheadBy, 'commit', 'commits')} ahead
      <span className="block text-small text-text-muted">of the integration branch</span>
    </span>
  );
}

/** Whether GitHub says the pull request can be merged without conflicts, as it reports it. */
function Mergeable({ pullRequest }: { pullRequest: PullRequest }) {
  if (pullRequest.mergeable === true) return <>Can be merged without conflicts</>;
  if (pullRequest.mergeable === false) return <>Has conflicts with the integration branch</>;
  if (pullRequest.state === 'draft' || pullRequest.state === 'open') {
    return <span className="text-text-dim">GitHub has not said yet</span>;
  }
  return <span className="text-text-dim">—</span>;
}

/**
 * "Bring up to date" (Issue #147): offered while the Run branch is behind the integration branch
 * and the Run can take a Follow-up. Says how far behind it is and whether GitHub reports
 * conflicts, and opens the confirm that explains what will happen and takes an optional note.
 */
function BringUpToDate({ run, pullRequest }: { run: RunOutput; pullRequest: PullRequest }) {
  const [open, setOpen] = useState(false);
  const behindBy = pullRequest.behindBy ?? 0;
  const offered = behindBy > 0 && run.followUp?.allowed === true;
  // Once the request is sent the Run is queued and the offer goes away. The confirm stays
  // mounted, so its own close (on success) still runs, and it is never shown without the offer.
  const conflicts =
    pullRequest.mergeable === false
      ? 'GitHub reports conflicts with the integration branch.'
      : pullRequest.mergeable === true
        ? 'GitHub reports no conflicts.'
        : 'GitHub has not said whether there are conflicts.';
  return (
    <>
      {offered ? (
        <div
          data-slot="run-bring-up-to-date"
          className="flex min-w-0 flex-col gap-2 border-t border-border pt-3"
        >
          <p className="m-0 text-body">
            The Run branch is {plural(behindBy, 'commit', 'commits')} behind the integration branch.{' '}
            {conflicts}
          </p>
          <div>
            <Button icon={GitMergeIcon} onClick={() => setOpen(true)}>
              Bring up to date
            </Button>
          </div>
        </div>
      ) : null}
      <BringUpToDateDialog run={run} open={open && offered} onOpenChange={setOpen} />
    </>
  );
}

/** When the state was last read. */
function Refreshed({ iso }: { iso: string | undefined }) {
  if (!iso) return <span className="text-text-dim">Not read yet</span>;
  const at = new Date(iso);
  return (
    <time dateTime={iso} className="tabular-nums">
      {formatExactTime(at)}
    </time>
  );
}

/**
 * The Run's pull request on GitHub (Issue #142): its number and link, its state (draft, open,
 * merged, closed or missing), the Run branch, how far the branch is behind and ahead of the
 * integration branch, whether GitHub says it can be merged without conflicts, and when this was
 * last read. The state comes from the agent worker, through the Agent account, so it is
 * refreshed on request: once when the page opens (the API holds that to once a minute per Run)
 * and with "Refresh". While a refresh is under way the card says so; when one failed, or no
 * agent worker is connected, it says that and keeps the last known state. Issue #145: the card
 * also lists the Pull request checks of the pull request's latest commit and offers to send the
 * failing ones to the agent; while any check is queued or running and the page is visible, it
 * refreshes them every 30 seconds (its own floor, apart from the once-a-minute limit of the
 * on-open request).
 */
export function RunPullRequest({ run, pullRequest }: { run: RunOutput; pullRequest: PullRequest }) {
  const titleId = useId();
  const refresh = useRefreshPullRequest(run.id);
  const { mutate } = refresh;
  // Once per opening of this Run's page; the API decides whether a request is recorded.
  const asked = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (asked.current === run.id) return;
    asked.current = run.id;
    mutate({ onOpen: true });
  }, [run.id, mutate]);

  const refreshing = refresh.isPending || pullRequest.refreshing === true;
  const unfinished = pullRequest.checks
    ? summarizeChecks(pullRequest.checks).unfinished > 0
    : false;
  // The page's own periodic refresh while a check has not finished: only while it is visible, and
  // never on top of one already under way.
  const latest = useRef({ refreshing, retryAt: pullRequest.retryAt });
  useEffect(() => {
    latest.current = { refreshing, retryAt: pullRequest.retryAt };
  });
  useEffect(() => {
    if (!unfinished) return;
    const timer = setInterval(() => {
      const { refreshing: underWay, retryAt: waitUntil } = latest.current;
      const waiting = waitUntil !== undefined && Date.parse(waitUntil) > Date.now();
      if (document.visibilityState === 'visible' && !underWay && !waiting) mutate(undefined);
    }, CHECKS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [unfinished, mutate]);
  const view = pullRequest.state ? PULL_REQUEST_STATE_VIEW[pullRequest.state] : undefined;
  const checked = pullRequest.state !== undefined;
  const retryAt = pullRequest.retryAt ? new Date(pullRequest.retryAt) : undefined;

  return (
    <Card aria-labelledby={titleId} data-slot="run-pull-request">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle id={titleId}>Pull request</CardTitle>
        <Button
          icon={RefreshCwIcon}
          loading={refreshing}
          onClick={() => mutate(undefined)}
          disabled={refreshing}
        >
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {refreshing ? (
          <p role="status" className="m-0 text-small text-text-muted">
            Refreshing the state from GitHub…
            {retryAt ? ` GitHub asked to wait; it tries again at ${formatExactTime(retryAt)}.` : ''}
          </p>
        ) : null}
        {pullRequest.refreshError && !refreshing ? (
          <Banner
            tone="warning"
            title={
              checked ? 'The state could not be refreshed.' : 'The state could not be checked.'
            }
          >
            {pullRequest.refreshError}{' '}
            {checked
              ? `The last known state is shown, from ${formatExactTime(new Date(pullRequest.refreshedAt ?? run.createdAt))}.`
              : 'A Follow-up is still possible.'}
          </Banner>
        ) : null}
        {refresh.isError ? (
          <Banner tone="danger" title="Couldn't refresh the state.">
            <span className="font-mono text-small">
              {failedRequest(REFRESH_REQUEST, refresh.error)}
            </span>
          </Banner>
        ) : null}
        <dl className="m-0 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
          <Fact term="Pull request">
            <PullRequestNumber pullRequest={pullRequest} />
          </Fact>
          <Fact term="State">
            {view ? (
              <StatusPill status={view.pill}>{view.label}</StatusPill>
            ) : (
              <StatusPill status="none">Not checked yet</StatusPill>
            )}
          </Fact>
          {run.runBranch ? (
            <Fact term="Run branch">
              <code className="font-mono text-code break-all">{run.runBranch}</code>
            </Fact>
          ) : null}
          <Fact term="Behind / ahead">
            <Position pullRequest={pullRequest} />
          </Fact>
          <Fact term="Mergeable">
            <Mergeable pullRequest={pullRequest} />
          </Fact>
          <Fact term="Last refreshed">
            <Refreshed iso={pullRequest.refreshedAt} />
          </Fact>
        </dl>
        <BringUpToDate run={run} pullRequest={pullRequest} />
        {pullRequest.state === 'missing' ? (
          <p className="m-0 text-small text-text-muted">
            The pull request, or the Run branch it came from, was not found on GitHub: it may be
            gone, or the Agent account cannot see it.
          </p>
        ) : null}
        <RunPullRequestChecks pullRequest={pullRequest} />
        <RunFailingChecks run={run} pullRequest={pullRequest} />
      </CardContent>
    </Card>
  );
}
