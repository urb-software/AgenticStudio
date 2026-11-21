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
import { useCloseRunPullRequest } from '../../api/runs-queries';
import { taskSummary } from '../../components/run-presentation';

type ClosePullRequestDialogProps = {
  run: RunOutput;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Destructive confirm: Studio closes the pull request with its Merge credential and deletes the
 * Run branch. A refusal stays in the dialog with its reason.
 */
export function ClosePullRequestDialog({ run, open, onOpenChange }: ClosePullRequestDialogProps) {
  const close = useCloseRunPullRequest(run.id);
  const problem = close.error instanceof ApiError ? close.error.problem : undefined;

  function changeOpen(next: boolean) {
    if (close.isPending) return;
    if (!next) close.reset();
    onOpenChange(next);
  }

  function confirm() {
    close.mutate(undefined, {
      onSuccess: () => {
        close.reset();
        onOpenChange(false);
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent destructive>
        <DialogHeader>
          <DialogTitle>Close without merging</DialogTitle>
          <DialogDescription className="break-words">{taskSummary(run.task)}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {close.error ? (
            <Banner tone="danger" title={problem?.title}>
              {problem?.detail || 'Could not close the pull request. Try again.'}
            </Banner>
          ) : null}
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-body">
            <li>The pull request is closed on GitHub without merging.</li>
            <li>The Run branch is deleted on GitHub. This cannot be undone from Studio.</li>
            <li>The run takes no more Follow-ups.</li>
            <li>The working copy is kept until its retention ends.</li>
          </ul>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={close.isPending}>
              Keep pull request
            </Button>
          </DialogClose>
          <Button variant="destructive" loading={close.isPending} onClick={confirm}>
            {close.isPending ? 'Closing…' : 'Close without merging'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
