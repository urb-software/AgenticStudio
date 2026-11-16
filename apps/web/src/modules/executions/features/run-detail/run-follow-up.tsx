'use client';

import { MessageSquarePlusIcon, SendIcon } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { TextField } from '@/shared/components/text-field';
import { formatExactTime } from '@/shared/lib/relative-time';
import { Button } from '@/shared/ui/button';
import { ApiError, type RunOutput } from '../../../../platform/api';
import { useFollowUpRun } from '../../api/runs-queries';

/** Longest Follow-up the API takes, in characters (the API's limit is authoritative). */
const FOLLOW_UP_MAX_LENGTH = 10_000;

type Refusal = NonNullable<NonNullable<RunOutput['followUp']>['reason']>;

/**
 * Why the Run cannot take a Follow-up (Issue #141), in plain words, and whether the operator
 * should start a new run instead ("Run again") rather than wait.
 */
function refusalText(run: RunOutput, reason: Refusal): { text: string; runAgain: boolean } {
  switch (reason) {
    case 'pull_request_merged':
      return {
        text: 'The pull request was merged on GitHub, so there is nothing left to update.',
        runAgain: true,
      };
    case 'pull_request_closed':
      return {
        text: 'The pull request was closed on GitHub. If you reopen it there, refresh its state and the Follow-up is possible again.',
        runAgain: true,
      };
    case 'pull_request_missing':
      return {
        text: 'The pull request or its run branch was not found on GitHub: it may be gone, or the Agent account cannot see it.',
        runAgain: true,
      };
    case 'working_copy_removed':
      return {
        text: 'The working copy was removed on the agent worker, so the run can no longer be continued. Its conversation, log, changes and pull request link stay here.',
        runAgain: true,
      };
    case 'no_session':
      return { text: 'The run has no agent session to continue.', runAgain: true };
    case 'step_total_reached':
      return {
        text: `The run has used all ${run.limits.maxTotalSteps} run steps it may take in total.`,
        runAgain: true,
      };
    case 'provider_unavailable':
      return {
        text: "The run's provider is unavailable on the agent worker. Send the Follow-up once it is available again.",
        runAgain: false,
      };
    case 'worker_unavailable':
      return {
        text: "The agent worker that holds the run's working copy is not connected. Send the Follow-up once it is back.",
        runAgain: false,
      };
    case 'follow_up_queued':
      return { text: 'A Follow-up is already queued for this run.', runAgain: false };
    case 'not_finished':
      return {
        text: 'The run is still working or waiting for you. Send a Follow-up once it has finished.',
        runAgain: false,
      };
  }
}

/**
 * "Open to Follow-ups until <date>" (Issue #143): when the Run's working copy and agent session
 * are kept until, moved by activity on the Run. Nothing when the page has no date.
 */
function OpenUntil({ openUntil }: { openUntil: string | undefined }) {
  if (openUntil === undefined) return null;
  return (
    <p className="m-0 text-small text-text-muted">
      Open to Follow-ups until{' '}
      <time dateTime={openUntil}>{formatExactTime(new Date(openUntil))}</time>. Activity on the run
      moves the date.
    </p>
  );
}

/** Server field errors (422 `errors[]`) for the text. */
function fieldError(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.status !== 422) return undefined;
  return error.problem?.errors?.[0]?.message ?? error.problem?.detail;
}

/**
 * The Follow-up on the Run page (Issue #141), for a finished Run whose page knows whether it can
 * take one: the operator's further instruction, which the same agent continues in the same
 * session and working copy, delivering to the same pull request. When it cannot, the section
 * says why, and points to "Run again" when only a new run can go on.
 */
export function RunFollowUp({
  run,
  followUp,
}: {
  run: RunOutput;
  followUp: NonNullable<RunOutput['followUp']>;
}) {
  const titleId = useId();
  if (!followUp.allowed) {
    const { text, runAgain } = refusalText(run, followUp.reason ?? 'not_finished');
    return (
      <section
        aria-labelledby={titleId}
        data-slot="run-follow-up"
        className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-4"
      >
        <h2 id={titleId} className="m-0 flex items-center gap-2 text-body font-semibold text-text">
          <MessageSquarePlusIcon aria-hidden="true" className="size-4" />
          Follow-up not possible
        </h2>
        <p className="m-0 text-small text-text-muted">
          {text}
          {runAgain ? ' Use “Run again” to start a new run with the same Task.' : null}
        </p>
        <OpenUntil openUntil={followUp.openUntil} />
      </section>
    );
  }
  return <FollowUpForm run={run} titleId={titleId} openUntil={followUp.openUntil} />;
}

function FollowUpForm({
  run,
  titleId,
  openUntil,
}: {
  run: RunOutput;
  titleId: string;
  openUntil: string | undefined;
}) {
  const [text, setText] = useState('');
  const [localError, setLocalError] = useState<string | undefined>();
  const send = useFollowUpRun(run.id);
  // Another Run's page reuses this form: nothing typed or refused for one Run carries over.
  const [formRun, setFormRun] = useState(run.id);
  if (formRun !== run.id) {
    setFormRun(run.id);
    setText('');
    setLocalError(undefined);
  }
  const { reset } = send;
  useEffect(() => reset(), [run.id, reset]);
  const error = localError ?? fieldError(send.error);
  const refused =
    send.error instanceof ApiError && send.error.status !== 422 ? send.error : undefined;

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed === '') {
      setLocalError('Enter a Follow-up.');
      return;
    }
    if (trimmed.length > FOLLOW_UP_MAX_LENGTH) {
      setLocalError(`Use at most ${FOLLOW_UP_MAX_LENGTH} characters.`);
      return;
    }
    setLocalError(undefined);
    send.mutate({ text: trimmed });
  }

  return (
    <section
      aria-labelledby={titleId}
      data-slot="run-follow-up"
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <h2 id={titleId} className="m-0 flex items-center gap-2 text-body font-semibold text-text">
        <MessageSquarePlusIcon aria-hidden="true" className="size-4" />
        Send a Follow-up
      </h2>
      <p className="m-0 text-small text-text-muted">
        The same agent continues its session in the same working copy, with what it already knows,
        and updates the same pull request.
      </p>
      <OpenUntil openUntil={openUntil} />
      {refused ? (
        <Banner tone="danger" title={refused.problem?.title ?? 'Could not send the Follow-up.'}>
          {refused.problem?.detail ?? 'Try again.'}
        </Banner>
      ) : null}
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-3" noValidate>
        <TextField
          multiline
          label="Follow-up"
          help="What the agent should do next. At most 10 000 characters."
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setLocalError(undefined);
          }}
          error={error}
          disabled={send.isPending}
          rows={3}
        />
        <div>
          <Button
            type="submit"
            variant="primary"
            icon={SendIcon}
            loading={send.isPending}
            disabled={send.isPending}
          >
            Send Follow-up
          </Button>
        </div>
      </form>
    </section>
  );
}
