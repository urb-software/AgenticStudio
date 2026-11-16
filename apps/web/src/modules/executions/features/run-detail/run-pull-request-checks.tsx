'use client';

import { ExternalLinkIcon } from 'lucide-react';
import { useId } from 'react';
import { Banner } from '@/shared/components/banner';
import { StatusPill } from '@/shared/components/status-pill';
import { formatDuration } from '@/shared/lib/duration';
import type { RunOutput } from '../../../../platform/api';
import { isGitHubUrl } from '../../components/github-links';
import { PULL_REQUEST_CHECK_VIEW, summarizeChecks } from '../../components/run-presentation';

type PullRequest = NonNullable<RunOutput['pullRequest']>;
type Check = NonNullable<PullRequest['checks']>[number];

/** Failed checks first, then in GitHub's order. */
function failedFirst(checks: readonly Check[]): Check[] {
  return [...checks].sort((a, b) => Number(b.state === 'failed') - Number(a.state === 'failed'));
}

/** A check's name, linked to its page on GitHub when it is one; its text is never markup. */
function CheckName({ check }: { check: Check }) {
  if (!isGitHubUrl(check.url)) return <span className="min-w-0 break-words">{check.name}</span>;
  return (
    <a
      href={check.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-w-0 items-center gap-1 text-brand no-underline hover:underline"
    >
      <span className="min-w-0 break-words">{check.name}</span>
      <ExternalLinkIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="sr-only">(opens GitHub in a new tab)</span>
    </a>
  );
}

/** The short form of a commit id, as the Run page shows commits. */
function Commit({ id }: { id: string }) {
  return (
    <code className="font-mono text-code" title={id}>
      {id.slice(0, 7)}
    </code>
  );
}

/**
 * The Pull request checks of the Run's pull request (Issue #145): GitHub's results for the pull
 * request's latest commit, which the section names, kept apart from the agent's own Reported
 * checks. A summary line says the overall picture, then each check with its state, duration and
 * link. It says so when the latest commit is not the Run's latest pushed one (someone else pushed),
 * and has its own words for no checks, checks that have not started, checks GitHub would not tell
 * and a lookup that failed. An ended pull request has none to show.
 */
export function RunPullRequestChecks({ pullRequest }: { pullRequest: PullRequest }) {
  const titleId = useId();
  const open = pullRequest.state === 'draft' || pullRequest.state === 'open';
  if (!open && pullRequest.checks === undefined && !pullRequest.checksUnavailable) return null;
  const checks = pullRequest.checks;
  const summary = checks && checks.length > 0 ? summarizeChecks(checks) : undefined;

  return (
    <section
      aria-labelledby={titleId}
      data-slot="run-pull-request-checks"
      className="flex min-w-0 flex-col gap-2.5 border-t border-border pt-3"
    >
      <h3 id={titleId} className="m-0 text-body font-semibold text-text">
        Pull request checks
      </h3>
      <p className="m-0 text-small text-text-muted">
        GitHub’s results for the pull request’s latest commit
        {pullRequest.checksCommit ? (
          <>
            {' '}
            <Commit id={pullRequest.checksCommit} />
          </>
        ) : null}
        . They are not the agent’s own account of its checks.
      </p>
      {pullRequest.checksOtherCommit ? (
        <Banner tone="warning" title="Someone else pushed to this branch.">
          These checks belong to the pull request’s latest commit, which is not the latest commit
          this run pushed.
        </Banner>
      ) : null}
      {pullRequest.checksUnavailable ? (
        <Banner tone="warning" title="GitHub did not tell the checks.">
          The Agent account needs read access to checks and commit statuses on this repository. The
          pull request’s state is shown without them.
        </Banner>
      ) : checks === undefined ? (
        <p className="m-0 text-small text-text-muted">
          {pullRequest.refreshError
            ? 'The checks could not be read: see the message above. Refresh tries again.'
            : 'The checks have not been read yet.'}
        </p>
      ) : checks.length === 0 ? (
        <p className="m-0 text-small text-text-muted">
          No checks are configured for this pull request. If the branch was pushed a moment ago,
          GitHub may not have started them yet: Refresh shows them as soon as it does.
        </p>
      ) : (
        <>
          <p
            data-slot="checks-summary"
            className="m-0 text-body font-medium text-text tabular-nums"
          >
            {summary?.text}
          </p>
          <ul
            role="list"
            aria-label="Pull request checks"
            className="m-0 flex list-none flex-col p-0"
          >
            {failedFirst(checks).map((check, index) => {
              const view = PULL_REQUEST_CHECK_VIEW[check.state];
              return (
                <li
                  key={`${index}-${check.name}`}
                  className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-2 last:border-b-0"
                >
                  <StatusPill status={view.pill}>{view.label}</StatusPill>
                  <span className="flex min-w-0 flex-1 basis-40 text-small">
                    <CheckName check={check} />
                  </span>
                  <span className="text-small text-text-muted tabular-nums">
                    {check.durationSeconds === undefined ? (
                      <>
                        <span aria-hidden="true">—</span>
                        <span className="sr-only">No duration</span>
                      </>
                    ) : (
                      formatDuration(check.durationSeconds * 1000)
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
