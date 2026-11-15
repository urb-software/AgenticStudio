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
import { useCancelRun } from '../../api/runs-queries';
import { taskSummary } from '../../components/run-presentation';

type CancelRunDialogProps = {
  run: RunOutput;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * The Cancel run confirm (Issue #100, design system: "Destructive = confirm"): a destructive
 * dialog (alertdialog; Radix traps focus; a bottom sheet on phones) that names the Run and says
 * what happens: the agent is stopped, nothing is pushed, the Working copy is kept. A queued or
 * waiting Run is cancelled at once; a running one shows "Cancel requested…" on the page until
 * the agent worker confirms. A refusal (the Run finished meanwhile) shows as a banner here.
 */
export function CancelRunDialog({ run, open, onOpenChange }: CancelRunDialogProps) {
  const cancel = useCancelRun(run.id);
  const problem = cancel.error instanceof ApiError ? cancel.error.problem : undefined;

  function changeOpen(next: boolean) {
    if (cancel.isPending) return;
    if (!next) cancel.reset();
    onOpenChange(next);
  }

  function confirm() {
    cancel.mutate(undefined, {
      onSuccess: () => {
        cancel.reset();
        onOpenChange(false);
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent destructive>
        <DialogHeader>
          <DialogTitle>Cancel run</DialogTitle>
          <DialogDescription className="break-words">{taskSummary(run.task)}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {cancel.error ? (
            <Banner tone="danger" title={problem?.title}>
              {problem?.detail || 'Could not cancel the run. Try again.'}
            </Banner>
          ) : null}
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-body">
            <li>The agent is stopped.</li>
            <li>
              Nothing more is pushed. If its delivery has already started, the draft pull request it
              opens stays on GitHub.
            </li>
            <li>The working copy is kept for inspection.</li>
          </ul>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={cancel.isPending}>
              Keep run
            </Button>
          </DialogClose>
          <Button variant="destructive" loading={cancel.isPending} onClick={confirm}>
            {cancel.isPending ? 'Cancelling…' : 'Cancel run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
