'use client';

import { GitMergeIcon, RefreshCwIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import {
  ApiError,
  type MergeReviewFileSummaryOutput,
  type MergeReviewOutput,
  type RunOutput,
} from '../../../../platform/api';
import { useMergeReview, useRequestMergeReview } from '../../api/runs-queries';
import { MERGE_UNAVAILABLE_REASON } from '../../components/merge-unavailable-reason';
import { Mono } from '../../components/mono';
import { failedRequest } from '../../components/failed-request';
import { FINAL_STATES } from '../../components/run-states';
import { MergeRunDialog } from '../merge-run/merge-run-dialog';
import { type ChangedFile, ChangedFiles } from '../run-changes/run-changes';

const READ_REQUEST = 'GET /api/runs/{runId}/merge-review';
const REQUEST_REVIEW = 'POST /api/runs/{runId}/merge-review';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The review's files in the shape the shared file list shows; a file whose patch was cut is "too large". */
function changedFiles(files: readonly MergeReviewFileSummaryOutput[]): ChangedFile[] {
  return files.map((file) => ({
    path: file.path,
    ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
    status: file.status,
    ...(file.binary ? { binary: true as const } : {}),
    ...(file.cut ? { tooLarge: true as const } : {}),
  }));
}

/** Whether a review can be requested for this pull request: it must not be over. */
function pullRequestIsOver(run: RunOutput): boolean {
  const state = run.pullRequest?.state;
  return state === 'merged' || state === 'closed' || state === 'missing';
}

/** Whether the Run's pull request can be merged now, as far as the page knows; the API decides. */
function canApproveAndMerge(run: RunOutput, data: MergeReviewOutput | undefined): boolean {
  const state = run.pullRequest?.state;
  return (
    data?.state === 'ready' &&
    data.runCommit !== undefined &&
    run.merge?.available === true &&
    FINAL_STATES.includes(run.state) &&
    (state === 'draft' || state === 'open') &&
    run.latestMergeApproval?.result !== 'carried_out' &&
    run.latestMergeApproval?.result !== 'pending'
  );
}

/**
 * What the Integration branch would gain from the Run's branch, computed by Studio from its own
 * clone (not the agent worker's account of the changes). Its files are shown with the same file
 * view as the Run diff.
 */
export function RunMergeReview({ run }: { run: RunOutput }) {
  return run.pullRequest === undefined ? null : <PullRequestReview run={run} />;
}

function PullRequestReview({ run }: { run: RunOutput }) {
  const titleId = useId();
  const review = useMergeReview(run);
  const request = useRequestMergeReview(run.id);
  const data = review.data;
  const preparing = data?.state === 'preparing' || request.isPending;
  const over = pullRequestIsOver(run);
  const [confirming, setConfirming] = useState(false);
  const mergeable = canApproveAndMerge(run, data);
  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={titleId} className="m-0 text-body font-semibold text-text">
          Merge review, computed by Studio
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {data ? (
            <Button
              icon={data.state === 'none' ? GitMergeIcon : RefreshCwIcon}
              variant={data.state === 'none' ? 'primary' : 'secondary'}
              loading={preparing}
              disabled={over}
              onClick={() => request.mutate()}
            >
              {data.state === 'none' ? 'Review for merge' : 'Review again'}
            </Button>
          ) : null}
          {mergeable ? (
            <Button variant="primary" icon={GitMergeIcon} onClick={() => setConfirming(true)}>
              Approve and merge
            </Button>
          ) : null}
        </div>
      </div>
      {data?.state === 'ready' && run.merge?.available === false && !over ? (
        <p className="m-0 text-small text-text-muted">
          Merging from Studio is off: {MERGE_UNAVAILABLE_REASON[run.merge.reason]}
        </p>
      ) : null}
      {mergeable && data?.runCommit ? (
        <MergeRunDialog
          run={run}
          commit={data.runCommit}
          open={confirming}
          onOpenChange={setConfirming}
        />
      ) : null}
      {over ? (
        <Banner tone="info">
          The pull request is {run.pullRequest?.state}: there is nothing left to review for merge.
        </Banner>
      ) : null}
      {request.error ? (
        <Banner tone="danger" title="Couldn't start the review.">
          {(request.error instanceof ApiError ? request.error.problem?.detail : undefined) ??
            failedRequest(REQUEST_REVIEW, request.error)}
        </Banner>
      ) : null}
      <ReviewBody run={run} data={data} loading={review.isPending} error={review.error} />
    </section>
  );
}

function ReviewBody({
  run,
  data,
  loading,
  error,
}: {
  run: RunOutput;
  data: MergeReviewOutput | undefined;
  loading: boolean;
  error: unknown;
}) {
  if (loading) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading the merge review"
        className="flex flex-col gap-2"
      >
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
    );
  }
  if (!data) {
    return (
      <Banner tone="danger" title="Couldn't load the merge review.">
        <span className="font-mono text-small">{failedRequest(READ_REQUEST, error)}</span>
      </Banner>
    );
  }
  switch (data.state) {
    case 'none':
      return (
        <p className="m-0 text-small text-text-muted">
          No review yet. Studio fetches the Run branch, merges it with the Integration branch in its
          own clone and shows what the Integration branch would gain. The agent worker’s changes
          below are its own account and are not what you approve.
        </p>
      );
    case 'preparing':
      return (
        <p role="status" className="m-0 text-small text-text-muted">
          Preparing the review: fetching the Run branch and computing the merge.
        </p>
      );
    case 'failed':
      return (
        <Banner tone="danger" title="The review failed.">
          <span className="break-words whitespace-pre-wrap">
            {data.failure ?? 'No reason was recorded.'}
          </span>
        </Banner>
      );
    default:
      return <ReviewFiles run={run} data={data} />;
  }
}

function ReviewFiles({ run, data }: { run: RunOutput; data: MergeReviewOutput }) {
  const files = changedFiles(data.files);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {data.state === 'out_of_date' ? (
        <Banner tone="warning" title="The Run branch moved on since this review.">
          This is the review of commit{' '}
          {data.runCommit ? <Mono>{data.runCommit.slice(0, 12)}</Mono> : 'an earlier one'}. Review
          again to see what would be merged now.
        </Banner>
      ) : null}
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-text-muted">
        <span className="font-medium text-text">
          {plural(files.length, 'file would change', 'files would change')}
        </span>
        {data.runCommit && data.integrationCommit ? (
          <span>
            Run branch <Mono>{data.runCommit.slice(0, 12)}</Mono> merged into the Integration branch
            at <Mono>{data.integrationCommit.slice(0, 12)}</Mono>
          </span>
        ) : null}
      </p>
      {data.truncated ? (
        <Banner tone="warning" title="Not every change is shown.">
          The review reached its size limit: some files are listed without their content, or not
          listed at all.
        </Banner>
      ) : null}
      {files.length === 0 ? (
        <p className="m-0 text-small text-text-muted">
          The Run branch adds nothing the Integration branch does not already have.
        </p>
      ) : (
        <ChangedFiles
          source={{ kind: 'merge-review', runId: run.id, runCommit: data.runCommit }}
          files={files}
          truncated={data.truncated}
          pullRequest={undefined}
        />
      )}
    </div>
  );
}
