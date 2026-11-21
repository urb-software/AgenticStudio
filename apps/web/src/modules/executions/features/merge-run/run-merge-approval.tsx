'use client';

import { GitMergeIcon } from 'lucide-react';
import Link from 'next/link';
import { Banner } from '@/shared/components/banner';
import { formatExactTime } from '@/shared/lib/relative-time';
import { Button } from '@/shared/ui/button';
import { ApiError, type MergeApprovalOutput, type RunOutput } from '../../../../platform/api';
import { MERGE_UNAVAILABLE_REASON } from '../../components/merge-unavailable-reason';
import { Mono } from '../../components/mono';
import { useMergeRun } from '../../api/runs-queries';

function Time({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} className="tabular-nums">
      {formatExactTime(new Date(iso))}
    </time>
  );
}

/** What is left after a merge, and the retry of just that. */
function StepsLeft({
  run,
  approval,
  branchLeft,
  fetchLeft,
}: {
  run: RunOutput;
  approval: MergeApprovalOutput;
  branchLeft: boolean;
  fetchLeft: boolean;
}) {
  const retry = useMergeRun(run.id);
  const problem = retry.error instanceof ApiError ? retry.error.problem : undefined;
  const failure = run.pullRequest?.runBranchDeletionFailure;
  return (
    <Banner tone="warning" title="The pull request is merged, but a step after it is not done.">
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
        {branchLeft ? (
          <li className="break-words">
            The Run branch is still on GitHub. {failure ?? 'Deleting it did not finish.'}
          </li>
        ) : null}
        {fetchLeft ? (
          <li>
            The Project&apos;s clone has not been told to fetch the merge yet. Another fetch may be
            running that started before the merge.
          </li>
        ) : null}
      </ul>
      {retry.error ? (
        <span className="mt-1 block break-words">
          {problem?.detail || 'Could not finish the steps. Try again.'}
        </span>
      ) : null}
      {run.merge?.available === true ? (
        <span className="mt-2 block">
          <Button
            icon={GitMergeIcon}
            loading={retry.isPending}
            onClick={() => retry.mutate(approval.commit)}
          >
            Finish the missing steps
          </Button>
        </span>
      ) : run.merge ? (
        <span className="mt-1 block">
          Finishing them from Studio is off: {MERGE_UNAVAILABLE_REASON[run.merge.reason]}
        </span>
      ) : null}
    </Banner>
  );
}

/** The pull request is merged on GitHub although the record says otherwise: the same request repairs it. */
function RecordMerged({ run, approval }: { run: RunOutput; approval: MergeApprovalOutput }) {
  const record = useMergeRun(run.id);
  return (
    <div>
      <Button
        icon={GitMergeIcon}
        loading={record.isPending}
        onClick={() => record.mutate(approval.commit)}
      >
        Record the merge
      </Button>
    </div>
  );
}

/**
 * The latest Merge approval of the Run: who merged, when and at which commit, what a merge left
 * undone, or why the last attempt was not carried out.
 */
export function RunMergeApproval({ run }: { run: RunOutput }) {
  const approval = run.latestMergeApproval;
  if (approval === undefined) return null;

  if (approval.result === 'pending') {
    return (
      <p role="status" className="m-0 border-t border-border pt-3 text-small text-text-muted">
        A merge is under way: approved <Time iso={approval.approvedAt} />.
      </p>
    );
  }

  if (approval.result === 'not_carried_out') {
    const mergedAnyway = run.pullRequest?.state === 'merged' && run.merge?.available === true;
    return (
      <div
        data-slot="run-merge-not-carried-out"
        className="flex min-w-0 flex-col gap-2 border-t border-border pt-3"
      >
        <Banner tone="warning" title="The last merge was not carried out.">
          <span className="block break-words">
            Approved <Time iso={approval.approvedAt} /> at{' '}
            <Mono>{approval.commit.slice(0, 12)}</Mono>.{' '}
            {approval.refusal?.reason ?? 'No reason was recorded.'}
          </span>
        </Banner>
        {mergedAnyway ? <RecordMerged run={run} approval={approval} /> : null}
      </div>
    );
  }

  const branchLeft = run.pullRequest?.runBranchDeletedAt === undefined;
  const fetchLeft = approval.cloneFetchStartedAt === undefined;
  return (
    <div
      data-slot="run-merged-from-studio"
      className="flex min-w-0 flex-col gap-2 border-t border-border pt-3"
    >
      <p className="m-0 text-body">
        <strong className="font-semibold">Merged from Studio</strong> by the operator{' '}
        {approval.completedAt ? <Time iso={approval.completedAt} /> : null}
        {approval.mergedCommit ? (
          <>
            {' '}
            as commit <Mono>{approval.mergedCommit.slice(0, 12)}</Mono>
          </>
        ) : null}{' '}
        (approved at <Mono>{approval.commit.slice(0, 12)}</Mono>, {approval.method}, into{' '}
        <Mono>{approval.integrationBranch}</Mono>).
        {branchLeft ? null : <> The Run branch was deleted.</>}
      </p>
      {branchLeft || fetchLeft ? (
        <StepsLeft run={run} approval={approval} branchLeft={branchLeft} fetchLeft={fetchLeft} />
      ) : (
        <p className="m-0 text-small text-text-muted">
          The Project&apos;s Repository was asked to fetch the merge. If that failed, the{' '}
          <Link href={`/projects/${run.projectId}`} className="text-brand underline">
            Repository
          </Link>{' '}
          shows why.
        </p>
      )}
    </div>
  );
}
