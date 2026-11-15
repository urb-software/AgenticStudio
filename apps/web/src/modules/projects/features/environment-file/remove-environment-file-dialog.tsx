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
import { ApiError } from '../../../../platform/api';
import { useRemoveEnvironmentFile } from '../../api/projects-queries';

type RemoveEnvironmentFileDialogProps = {
  projectId: string;
  /** The file's path, named in the dialog. */
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the removal; the card confirms it. */
  onRemoved: () => void;
};

/**
 * The Remove environment file confirm (design system: "Destructive = confirm"): says what is
 * deleted and what is kept. A refusal shows as a banner here.
 */
export function RemoveEnvironmentFileDialog({
  projectId,
  path,
  open,
  onOpenChange,
  onRemoved,
}: RemoveEnvironmentFileDialogProps) {
  const remove = useRemoveEnvironmentFile(projectId);
  const problem = remove.error instanceof ApiError ? remove.error.problem : undefined;

  function changeOpen(next: boolean) {
    if (remove.isPending) return;
    if (!next) remove.reset();
    onOpenChange(next);
  }

  function confirm() {
    remove.mutate(undefined, {
      onSuccess: () => {
        remove.reset();
        onOpenChange(false);
        onRemoved();
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent destructive>
        <DialogHeader>
          <DialogTitle>Remove environment file</DialogTitle>
          <DialogDescription>
            <code className="text-code break-all">{path}</code>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {remove.error ? (
            <Banner tone="danger" title={problem?.title}>
              {problem?.detail || 'Could not remove the environment file. Try again.'}
            </Banner>
          ) : null}
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-body">
            <li>Studio deletes the stored content.</li>
            <li>Runs started from now on get no environment file.</li>
            <li>Runs already started keep the copy they were given.</li>
          </ul>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={remove.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" loading={remove.isPending} onClick={confirm}>
            {remove.isPending ? 'Removing…' : 'Remove environment file'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
