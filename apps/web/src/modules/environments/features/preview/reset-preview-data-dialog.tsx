'use client';

import { ProjectName } from '@/modules/projects';
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
import { ApiError } from '../../../../platform/api';
import { useResetPreviewData } from '../../api/preview-queries';

type ResetPreviewDataDialogProps = {
  projectId: string;
  /** The commit a running Preview is rebuilt from; `null` when nothing runs. */
  rebuildCommit: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** The Reset data confirm (design system: "Destructive = confirm"). A refusal shows as a banner. */
export function ResetPreviewDataDialog({
  projectId,
  rebuildCommit,
  open,
  onOpenChange,
}: ResetPreviewDataDialogProps) {
  const reset = useResetPreviewData(projectId);
  const problem = reset.error instanceof ApiError ? reset.error.problem : undefined;

  function changeOpen(next: boolean) {
    if (reset.isPending) return;
    if (!next) reset.reset();
    onOpenChange(next);
  }

  function confirm() {
    reset.mutate(undefined, {
      onSuccess: () => {
        reset.reset();
        onOpenChange(false);
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent destructive>
        <DialogHeader>
          <DialogTitle>Reset the Preview&apos;s data?</DialogTitle>
          <DialogDescription>
            This removes the volumes of{' '}
            <strong>
              <ProjectName projectId={projectId} />
            </strong>
            &apos;s Preview for good: its databases, uploads and anything else it stored.
            {rebuildCommit ? (
              <>
                {' '}
                The Preview is then rebuilt from commit{' '}
                <code className="font-mono text-code" title={rebuildCommit}>
                  {rebuildCommit.slice(0, 7)}
                </code>
                .
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        {reset.error ? (
          <DialogBody>
            <Banner tone="danger" title={problem?.title}>
              {problem?.detail || 'Could not reset the Preview. Try again.'}
            </Banner>
          </DialogBody>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={reset.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" loading={reset.isPending} onClick={confirm}>
            {reset.isPending ? 'Resetting…' : 'Reset data'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
