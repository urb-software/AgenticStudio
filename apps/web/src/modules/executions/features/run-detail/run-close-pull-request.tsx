'use client';

import { GitPullRequestClosedIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { formatExactTime } from '@/shared/lib/relative-time';
import { Button } from '@/shared/ui/button';
import { ApiError, type RunOutput } from '../../../../platform/api';
import { useCloseRunPullRequest } from '../../api/runs-queries';
import { FINAL_STATES } from '../../components/run-states';
import { ClosePullRequestDialog } from '../close-pull-request/close-pull-request-dialog';

type PullRequest = NonNullable<RunOutput['pullRequest']>;

const MERGE_UNAVAILABLE_TEXT = {
  not_configured:
    "Closing the pull request from Studio is off: Studio's Merge credential is not configured.",
  unsupported_host:
    "Closing the pull request from Studio is off: this run's Git host is not supported.",
} as const;

function Time({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} className="tabular-nums">
      {formatExactTime(new Date(iso))}
    </time>
  );
}

/** What is left after a close whose branch deletion failed, and the retry of just that. */
function BranchLeft({ run, failure }: { run: RunOutput; failure: string }) {
  const retry = useCloseRunPullRequest(run.id);
  const problem = retry.error instanceof ApiError ? retry.error.problem : undefined;
  return (
    <Banner
      tone="warning"
      title="The pull request is closed, but the Run branch is still on GitHub."
    >
      <span className="block break-words">{failure}</span>
      {retry.error ? (
        <span className="mt-1 block break-words">
          {problem?.detail || 'Could not delete the Run branch. Try again.'}
        </span>
      ) : null}
      {run.merge?.available === true ? (
        <span className="mt-2 block">
          <Button
            icon={Trash2Icon}
            loading={retry.isPending}
            onClick={() => retry.mutate(undefined)}
          >
            Delete the Run branch again
          </Button>
        </span>
      ) : null}
    </Banner>
  );
}

/**
 * "Close without merging" for a finished Run whose pull request is draft or open, when Studio
 * can merge; what the close left behind afterwards; or why the action is not available.
 */
export function RunClosePullRequest({
  run,
  pullRequest,
}: {
  run: RunOutput;
  pullRequest: PullRequest;
}) {
  const [open, setOpen] = useState(false);
  const { merge } = run;
  const finished = FINAL_STATES.includes(run.state);
  const live = pullRequest.state === 'draft' || pullRequest.state === 'open';
  const { closedFromStudioAt, runBranchDeletedAt, runBranchDeletionFailure } = pullRequest;

  return (
    <>
      {closedFromStudioAt ? (
        <div
          data-slot="run-closed-from-studio"
          className="flex min-w-0 flex-col gap-2 border-t border-border pt-3"
        >
          <p className="m-0 text-body">
            <strong className="font-semibold">Closed from Studio</strong>{' '}
            <Time iso={closedFromStudioAt} />
            {runBranchDeletedAt ? (
              <>
                . The Run branch was deleted <Time iso={runBranchDeletedAt} />.
              </>
            ) : null}
          </p>
          {runBranchDeletionFailure ? (
            <BranchLeft run={run} failure={runBranchDeletionFailure} />
          ) : null}
        </div>
      ) : finished && live && merge ? (
        <div
          data-slot="run-close-without-merging"
          className="flex min-w-0 flex-col gap-2 border-t border-border pt-3"
        >
          {merge.available ? (
            <div>
              <Button
                variant="danger"
                icon={GitPullRequestClosedIcon}
                onClick={() => setOpen(true)}
              >
                Close without merging
              </Button>
            </div>
          ) : (
            <p className="m-0 text-small text-text-muted">{MERGE_UNAVAILABLE_TEXT[merge.reason]}</p>
          )}
        </div>
      ) : null}
      <ClosePullRequestDialog run={run} open={open} onOpenChange={setOpen} />
    </>
  );
}
