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
import { ApiError, type RunOutput } from '../../../../platform/api';
import { useBringUpToDateRun } from '../../api/runs-queries';
import { taskSummary } from '../../components/run-presentation';

/** Longest note the API takes, in characters (the API's limit is authoritative). */
const NOTE_MAX_LENGTH = 10_000;

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
 * The "Bring up to date" confirm (Issue #147): says what will happen before anything does, and
 * takes an optional note for the agent. The branch is only ever brought up to date by merging the
 * integration branch into it (never a rebase, never a force push), and only on this request. A
 * refusal (the Run can no longer take a Follow-up) shows as a banner; a note the API refuses, next
 * to the field. A bottom sheet on phones; it cannot be closed while the request is in flight.
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
    if (trimmed.length > NOTE_MAX_LENGTH) {
      setLocalError(`Use at most ${NOTE_MAX_LENGTH} characters.`);
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
              help="For example, which side to prefer in a conflict. At most 10 000 characters."
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
