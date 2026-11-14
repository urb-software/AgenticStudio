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
import { useDisconnectRepository } from '../../api/projects-queries';

/** The confirmation of a finished disconnect. */
export const DISCONNECTED_MESSAGE = 'Repository disconnected';

/**
 * One toast per project: the dialog's 204 and the card's polling (which can see the Repository
 * gone first, e.g. during a retried disconnect) may both confirm the same disconnect.
 */
export function disconnectedToastId(projectId: string): string {
  return `repository-disconnected-${projectId}`;
}

type DisconnectRepositoryDialogProps = {
  projectId: string;
  /** The Repository's URL as entered, named in the dialog. */
  url: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Confirms a disconnect that removed everything (204). It runs even when the dialog has
   * unmounted meanwhile, so the confirmation is never lost.
   */
  onDisconnected: () => void;
};

/**
 * The Disconnect repository confirm (design system: "Destructive = confirm"): a destructive
 * dialog (alertdialog; a bottom sheet on phones) that names the Repository and says what is
 * kept and what is deleted. Confirming is the operator's explicit authorization of the
 * destructive Git operation (security.md §4). When everything is removed at once it closes
 * and `onDisconnected` confirms it (the toast "Repository disconnected"); when the server's
 * cleanup is still pending it closes and the card shows "Disconnecting…". A refusal shows as a
 * banner here.
 */
export function DisconnectRepositoryDialog({
  projectId,
  url,
  open,
  onOpenChange,
  onDisconnected,
}: DisconnectRepositoryDialogProps) {
  const disconnect = useDisconnectRepository(projectId, onDisconnected);
  const problem = disconnect.error instanceof ApiError ? disconnect.error.problem : undefined;

  function changeOpen(next: boolean) {
    if (disconnect.isPending) return;
    if (!next) disconnect.reset();
    onOpenChange(next);
  }

  function confirm() {
    disconnect.mutate(undefined, {
      // Closes once, on a 204 and on a 202 alike.
      onSuccess: () => {
        disconnect.reset();
        onOpenChange(false);
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent destructive>
        <DialogHeader>
          <DialogTitle>Disconnect repository</DialogTitle>
          <DialogDescription>
            <code className="text-code break-all">{url}</code>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {disconnect.error ? (
            <Banner tone="danger" title={problem?.title}>
              {problem?.detail || 'Could not disconnect the repository. Try again.'}
            </Banner>
          ) : null}
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-body">
            <li>The project is kept.</li>
            <li>Studio&apos;s clone and deploy key are deleted.</li>
            <li>The remote repository is untouched.</li>
            <li>A deploy key added on the Git host stays there until removed there.</li>
          </ul>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={disconnect.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" loading={disconnect.isPending} onClick={confirm}>
            {disconnect.isPending ? 'Disconnecting…' : 'Disconnect repository'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
