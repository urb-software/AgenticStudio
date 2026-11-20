'use client';

import { GitMergeIcon } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { TextField } from '@/shared/components/text-field';
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
import { ApiError, bringUpToDateRequestHint, type RunOutput } from '../../../../platform/api';
import { useBringUpToDateRun } from '../../api/runs-queries';
import { taskSummary } from '../../components/run-presentation';

type BringUpToDateDialogProps = {
  run: RunOutput;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Server field errors (422 `errors[]`) for the note. */
function noteError(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.status !== 422) return undefined;
  return error.problem?.errors?.[0]?.message ?? error.problem?.detail;
}

/**
 * The branch is only ever brought up to date by merging the integration branch into it (never a
 * rebase, never a force push), and only on this request.
 */
export function BringUpToDateDialog({ run, open, onOpenChange }: BringUpToDateDialogProps) {
  const [note, setNote] = useState('');
  const [localError, setLocalError] = useState<string | undefined>();
  const send = useBringUpToDateRun(run.id);
  const listId = useId();
  const refused =
    send.error instanceof ApiError && send.error.status !== 422 ? send.error : undefined;
  const error = localError ?? noteError(send.error);

  function close() {
    setNote('');
    setLocalError(undefined);
    send.reset();
    onOpenChange(false);
  }

  function changeOpen(next: boolean) {
    if (next) onOpenChange(true);
    else if (!send.isPending) close();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = note.trim();
    // The generated schema counts characters as the API does (code points), and says the limit.
    const checked = bringUpToDateRequestHint.safeParse({ note: trimmed });
    if (!checked.success) {
      const issue = checked.error.issues[0];
      setLocalError(
        issue?.code === 'too_big'
          ? `Use at most ${String(issue.maximum)} characters.`
          : 'Check the note and try again.',
      );
      return;
    }
    setLocalError(undefined);
    send.mutate(trimmed === '' ? {} : { note: trimmed }, { onSuccess: close });
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>Bring up to date</DialogTitle>
            <DialogDescription className="break-words">{taskSummary(run.task)}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {refused ? (
              <Banner tone="danger" title={refused.problem?.title ?? 'Could not start the update.'}>
                {refused.problem?.detail ?? 'Try again.'}
              </Banner>
            ) : null}
            <p id={listId} className="m-0 text-body">
              What happens, in this order:
            </p>
            <ol aria-labelledby={listId} className="m-0 flex list-decimal flex-col gap-1.5 pl-5">
              <li>
                Anything the agent left uncommitted in the working copy is committed first, so
                nothing is lost.
              </li>
              <li>
                The agent worker fetches the integration branch and merges it into the Run branch.
                It never rebases and never force-pushes.
              </li>
              <li>
                Without conflicts, the agent runs the project&rsquo;s checks and fixes what the
                update broke. With conflicts, it resolves them, completes the merge and runs the
                checks.
              </li>
              <li>The result goes to the same pull request.</li>
            </ol>
            <p className="m-0 text-small text-text-muted">
              If the agent ends with conflicts unresolved, the merge is aborted, nothing is pushed
              and the run ends as failed; you can try again. If the branch turns out to be up to
              date already, nothing changes. This counts as a Follow-up for the run&rsquo;s step
              limits.
            </p>
            <TextField
              multiline
              label="Note for the agent (optional)"
              help="For example, which side to prefer in a conflict."
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
                setLocalError(undefined);
              }}
              error={error}
              disabled={send.isPending}
              rows={3}
            />
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" type="button" disabled={send.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant="primary"
              icon={GitMergeIcon}
              loading={send.isPending}
              disabled={send.isPending}
            >
              Bring up to date
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
