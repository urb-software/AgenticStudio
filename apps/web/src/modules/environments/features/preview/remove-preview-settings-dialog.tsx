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
import { useRemovePreviewSettings } from '../../api/preview-queries';

type RemovePreviewSettingsDialogProps = {
  projectId: string;
  /** The Compose file the settings name, shown in the dialog. */
  composeFile: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the removal; the page confirms it. */
  onRemoved: () => void;
};

/** The Remove settings confirm (design system: "Destructive = confirm"). A refusal shows as a banner. */
export function RemovePreviewSettingsDialog({
  projectId,
  composeFile,
  open,
  onOpenChange,
  onRemoved,
}: RemovePreviewSettingsDialogProps) {
  const remove = useRemovePreviewSettings(projectId);
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
          <DialogTitle>Remove Preview settings</DialogTitle>
          <DialogDescription>
            <code className="text-code break-all">{composeFile}</code>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {remove.error ? (
            <Banner tone="danger" title={problem?.title}>
              {problem?.detail || 'Could not remove the Preview settings. Try again.'}
            </Banner>
          ) : null}
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-body">
            <li>The project has no Preview until you set it up again.</li>
            <li>Nothing in the repository changes.</li>
          </ul>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={remove.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" loading={remove.isPending} onClick={confirm}>
            {remove.isPending ? 'Removing…' : 'Remove Preview settings'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
