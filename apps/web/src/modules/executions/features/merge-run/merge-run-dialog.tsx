'use client';

import { Banner } from '@/shared/components/banner';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { ApiError, type RunOutput } from '../../../../platform/api';
import { useMergeRun, useRunProject } from '../../api/runs-queries';
import { mergeMethodLabel } from '../../components/merge-method-label';
import { Mono } from '../../components/mono';
import { summarizeChecks, taskSummary } from '../../components/run-presentation';

const CHECKS_LISTED = 8;

type MergeRunDialogProps = {
  run: RunOutput;
  /** The commit of the merge review the operator looked at. */
  commit: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** The checks as the page last read them; the API reads them again before it merges. */
function ChecksSeen({ pullRequest }: { pullRequest: NonNullable<RunOutput['pullRequest']> }) {
  const { checks, checksUnavailable, checksOtherCommit } = pullRequest;
  if (checks === undefined) {
    return (
      <p className="m-0 text-small text-text-muted">
        {checksUnavailable
          ? 'The checks could not be read when the page last looked.'
          : 'The page has not read the checks yet.'}{' '}
        Studio reads them from GitHub before it merges.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="m-0 text-body">
        {summarizeChecks(checks).text}
        {checksOtherCommit ? ' (of an earlier commit)' : ''}
      </p>
      {checks.length > 0 ? (
        <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-small text-text-muted">
          {checks.slice(0, CHECKS_LISTED).map((check, index) => (
            <li key={`${check.name}-${index}`} className="break-words">
              {check.name}: {check.state}
            </li>
          ))}
          {checks.length > CHECKS_LISTED ? <li>and {checks.length - CHECKS_LISTED} more</li> : null}
        </ul>
      ) : null}
      <p className="m-0 text-small text-text-muted">Studio reads them again before it merges.</p>
    </div>
  );
}

/**
 * The one confirmation before a merge. It names what the operator reviewed; the API checks the
 * commit, the pull request and its checks again, and a refusal stays here with its reason.
 */
export function MergeRunDialog({ run, commit, open, onOpenChange }: MergeRunDialogProps) {
  const merge = useMergeRun(run.id);
  const { data: project } = useRunProject(run.projectId);
  const problem = merge.error instanceof ApiError ? merge.error.problem : undefined;
  const { pullRequest } = run;

  function changeOpen(next: boolean) {
    if (merge.isPending) return;
    if (!next) merge.reset();
    onOpenChange(next);
  }

  function confirm() {
    merge.mutate(commit, {
      onSuccess: () => {
        merge.reset();
        onOpenChange(false);
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent destructive>
        <DialogHeader>
          <DialogTitle>Approve and merge</DialogTitle>
          <DialogDescription className="break-words">{taskSummary(run.task)}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {merge.error ? (
            <Banner tone="danger" title={problem?.title}>
              {problem?.detail || 'Could not merge the pull request. Try again.'}
            </Banner>
          ) : null}
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-body">
            <dt className="text-text-muted">Commit</dt>
            <dd className="m-0">
              <Mono>{commit.slice(0, 12)}</Mono>
            </dd>
            <dt className="text-text-muted">Merges into</dt>
            <dd className="m-0">
              {run.integrationBranch ? (
                <Mono>{run.integrationBranch}</Mono>
              ) : (
                'the Integration branch'
              )}
            </dd>
            <dt className="text-text-muted">Method</dt>
            <dd className="m-0">
              {project ? (
                mergeMethodLabel(project.mergeMethod)
              ) : (
                <span className="text-text-muted">The Project&apos;s setting</span>
              )}
            </dd>
          </dl>
          {pullRequest ? <ChecksSeen pullRequest={pullRequest} /> : null}
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-body">
            <li>Your approving review is submitted on GitHub.</li>
            <li>The pull request is merged pinned to this commit, and refused if it moved.</li>
            <li>The method is the Project&apos;s setting, read again when Studio merges.</li>
            <li>The Run branch is deleted on GitHub and the Project&apos;s clone is fetched.</li>
            <li>The run takes no more Follow-ups.</li>
          </ul>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={merge.isPending}>
              Not yet
            </Button>
          </DialogClose>
          <Button variant="primary" loading={merge.isPending} onClick={confirm}>
            {merge.isPending ? 'Merging…' : 'Approve and merge'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
