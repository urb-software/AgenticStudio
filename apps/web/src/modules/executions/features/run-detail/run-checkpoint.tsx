'use client';

import { ArrowRightIcon, FileDiffIcon, FlagIcon } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
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
import { useContinueRun, useStopRun } from '../../api/runs-queries';

/** Longest note the API takes, in characters (the API's limit is authoritative). */
const COMMENT_MAX_LENGTH = 4000;

type Checkpoint = { id: string; text: string };

/** The Phase the Workflow ran just before the Checkpoint, and whether a Phase follows it. */
function around(run: RunOutput, checkpoint: Checkpoint) {
  const items = run.workflow?.items ?? [];
  const at = items.findIndex((item) => item.id === checkpoint.id);
  const before = items.slice(0, Math.max(at, 0)).findLast((item) => item.kind !== 'checkpoint');
  const reported = before && run.phases?.find((phase) => phase.itemId === before.id);
  const follows = at >= 0 && items.slice(at + 1).some((item) => item.kind !== 'checkpoint');
  return { before, reported, follows };
}

/** The server's refusal, as the page words it: a 409 says the Run moved on. */
function Refusal({ error }: { error: unknown }) {
  if (!(error instanceof ApiError) || error.status === 422) return null;
  return (
    <Banner tone="danger" title={error.problem?.title ?? 'Could not send this.'}>
      {error.problem?.detail ?? 'Try again.'}
    </Banner>
  );
}

/** "Stop here" asks first: the Workflow ends and the Run delivers what exists. */
function StopDialog({
  runId,
  checkpoint,
  open,
  onOpenChange,
}: {
  runId: string;
  checkpoint: Checkpoint;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const stop = useStopRun(runId);

  function changeOpen(next: boolean) {
    if (stop.isPending) return;
    if (!next) stop.reset();
    onOpenChange(next);
  }

  function confirm() {
    stop.mutate(
      { checkpoint: checkpoint.id },
      {
        onSuccess: () => {
          stop.reset();
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent destructive>
        <DialogHeader>
          <DialogTitle>Stop here</DialogTitle>
          <DialogDescription>
            The Workflow ends at this Checkpoint. The Phases after it do not run.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Refusal error={stop.error} />
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-body">
            <li>
              The Run delivers what exists, once: a draft pull request when the working copy holds a
              change.
            </li>
            <li>With no change, the Run finishes without a pull request.</li>
            <li>This cannot be undone. To end the Run without delivering, cancel it instead.</li>
          </ul>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={stop.isPending}>
              Keep waiting
            </Button>
          </DialogClose>
          <Button variant="destructive" loading={stop.isPending} onClick={confirm}>
            Stop here and deliver
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Run waits at a Checkpoint of its Workflow: its text, what the Phase before it reported (as
 * text), a way to the Changes tab, "Continue" with an optional note for the next Phase, and "Stop
 * here" with a confirmation. The operator's colour (amber) means "you".
 */
export function RunCheckpoint({
  run,
  checkpoint,
  onShowChanges,
}: {
  run: RunOutput;
  checkpoint: Checkpoint;
  /** Shows the Changes tab. */
  onShowChanges: () => void;
}) {
  const [note, setNote] = useState('');
  const [localError, setLocalError] = useState<string | undefined>();
  const [stopping, setStopping] = useState(false);
  const proceed = useContinueRun(run.id);
  // Another Run's page reuses this card: nothing typed or refused for one carries over.
  const [formRun, setFormRun] = useState(`${run.id}/${checkpoint.id}`);
  if (formRun !== `${run.id}/${checkpoint.id}`) {
    setFormRun(`${run.id}/${checkpoint.id}`);
    setNote('');
    setLocalError(undefined);
  }
  const { reset } = proceed;
  useEffect(() => reset(), [run.id, checkpoint.id, reset]);
  const titleId = useId();
  const { before, reported, follows } = around(run, checkpoint);
  const disabled = run.state !== 'waiting_for_operator' || proceed.isPending;
  const problem =
    proceed.error instanceof ApiError && proceed.error.status === 422
      ? (proceed.error.problem?.errors?.[0]?.message ?? proceed.error.problem?.detail)
      : undefined;

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = note.trim();
    if (trimmed.length > COMMENT_MAX_LENGTH) {
      setLocalError('Use at most 4,000 characters.');
      return;
    }
    setLocalError(undefined);
    proceed.mutate({
      ...(trimmed === '' ? {} : { comment: trimmed }),
      checkpoint: checkpoint.id,
    });
  }

  return (
    <section
      aria-labelledby={titleId}
      data-slot="run-checkpoint"
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-run-awaiting/35 bg-run-awaiting-soft p-4"
    >
      <h2
        id={titleId}
        className="m-0 flex items-center gap-2 text-body font-semibold text-run-awaiting"
      >
        <FlagIcon aria-hidden="true" className="size-4" />
        Your Workflow is waiting for you
      </h2>
      <p className="m-0 break-words whitespace-pre-wrap text-text">{checkpoint.text}</p>
      <div className="flex min-w-0 flex-col gap-1">
        {before && reported ? (
          <>
            <p className="m-0 text-small text-text-muted">
              Reported by Phase <span className="font-mono text-code break-all">{before.id}</span>{' '}
              (agent <span className="font-mono text-code break-all">{reported.agent.name}</span>) :
            </p>
            {/* The agent's text, shown as text: never markup. */}
            <p
              data-testid="run-checkpoint-report"
              className="m-0 break-words whitespace-pre-wrap text-text"
            >
              {reported.summary ?? 'The Phase reported nothing.'}
            </p>
          </>
        ) : (
          <p className="m-0 text-small text-text-muted">
            No Phase has run yet: this Checkpoint comes first, so there is nothing to look at.
          </p>
        )}
      </div>
      <div>
        <Button variant="secondary" size="sm" icon={FileDiffIcon} onClick={onShowChanges}>
          See what changed
        </Button>
      </div>
      <Refusal error={proceed.error} />
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-3" noValidate>
        {follows ? (
          <TextField
            multiline
            label="Note for the next Phase (optional)"
            help="The next agent reads it as text after its instructions. It cannot change Studio's rules."
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
              setLocalError(undefined);
            }}
            error={localError ?? problem}
            disabled={disabled}
            rows={3}
          />
        ) : (
          <p className="m-0 text-small text-text-muted">
            No Phase follows this Checkpoint: Continue ends the Workflow, and the Run delivers what
            exists.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="primary"
            icon={ArrowRightIcon}
            loading={proceed.isPending}
            disabled={disabled}
          >
            Continue
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            onClick={() => setStopping(true)}
          >
            Stop here
          </Button>
        </div>
      </form>
      <StopDialog
        runId={run.id}
        checkpoint={checkpoint}
        open={stopping}
        onOpenChange={setStopping}
      />
    </section>
  );
}
