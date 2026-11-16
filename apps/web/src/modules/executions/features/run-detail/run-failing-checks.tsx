'use client';

import { SendIcon, Trash2Icon } from 'lucide-react';
import { useId, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { TextField } from '@/shared/components/text-field';
import { Button } from '@/shared/ui/button';
import { ApiError, type PreparedFollowUpOutput, type RunOutput } from '../../../../platform/api';
import {
  useDiscardPreparedFollowUp,
  useFollowUpRun,
  usePrepareFailingChecks,
  usePreparedFollowUp,
} from '../../api/runs-queries';
import { failedRequest } from '../../components/failed-request';
import { isGitHubUrl } from '../../components/github-links';

type PullRequest = NonNullable<RunOutput['pullRequest']>;

/** Longest Follow-up the API takes, in characters (the API's limit is authoritative). */
const FOLLOW_UP_MAX_LENGTH = 10_000;

const PREPARE_REQUEST = 'POST /api/runs/{runId}/pull-request/failing-checks/prepare';
const PREPARED_REQUEST = 'GET /api/runs/{runId}/pull-request/failing-checks/prepared';

/** The text without a check's section, and without the blank lines it leaves behind. */
function withoutSection(text: string, section: string): string {
  return text
    .replace(section, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

/**
 * The prepared Follow-up for review (Issue #145): which failing checks go in, and the text, which
 * the operator can change freely. Nothing is sent until "Send Follow-up". The text comes from CI
 * jobs, so it is shown only in a text box, as plain text, and the operator reads it before it
 * reaches an agent. A deselected check leaves its part of the text; a part the operator edited
 * is left alone and said so.
 */
function PreparedPreview({
  run,
  draft,
  sendable,
}: {
  run: RunOutput;
  draft: PreparedFollowUpOutput;
  /** Whether the Run can take the Follow-up now. */
  sendable: boolean;
}) {
  const noteId = useId();
  const [text, setText] = useState(draft.text);
  const [included, setIncluded] = useState(() => new Set(draft.checks.map((_, index) => index)));
  const [notice, setNotice] = useState<string | undefined>();
  const send = useFollowUpRun(run.id);
  const discard = useDiscardPreparedFollowUp(run.id);
  const busy = send.isPending || discard.isPending;
  const trimmed = text.trim();
  const tooLong = trimmed.length > FOLLOW_UP_MAX_LENGTH;
  const refused =
    send.error instanceof ApiError && send.error.status !== 422 ? send.error : undefined;
  const fieldError =
    send.error instanceof ApiError && send.error.status === 422
      ? (send.error.problem?.errors?.[0]?.message ?? send.error.problem?.detail)
      : undefined;
  const problem = tooLong
    ? `Use at most ${FOLLOW_UP_MAX_LENGTH} characters: leave out a check or shorten the text.`
    : trimmed === ''
      ? 'Enter a Follow-up.'
      : fieldError;

  function toggle(index: number, checked: boolean) {
    const check = draft.checks[index]!;
    const next = new Set(included);
    if (checked) {
      next.add(index);
      if (!text.includes(check.section)) {
        setText(`${text.trimEnd()}\n\n${check.section}`);
      }
      setNotice(undefined);
    } else {
      next.delete(index);
      if (text.includes(check.section)) {
        setText(withoutSection(text, check.section));
        setNotice(undefined);
      } else {
        setNotice(
          `The part of the text for “${check.name}” was edited, so it stays in the text: remove it there yourself.`,
        );
      }
    }
    setIncluded(next);
  }

  return (
    <div data-slot="prepared-follow-up" className="flex min-w-0 flex-col gap-3">
      <Banner tone="info" title="Review before anything is sent.">
        This Follow-up was prepared from the failing Pull request checks on GitHub. The log excerpts
        are output of CI jobs and can say anything, including instructions aimed at an agent: they
        are shown as plain text, and nothing reaches the agent until you send it.
      </Banner>
      <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
        <legend className="mb-1 p-0 text-small font-medium text-text">
          Failing checks to send
        </legend>
        {draft.checks.map((check, index) => (
          <label
            key={`${index}-${check.name}`}
            className="flex min-h-9 min-w-0 cursor-pointer items-start gap-2.5 py-1 text-small"
          >
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-brand"
              checked={included.has(index)}
              disabled={busy}
              onChange={(event) => toggle(index, event.target.checked)}
            />
            <span className="min-w-0">
              <span className="font-medium break-words text-text">{check.name}</span>
              <span className="block text-text-muted">
                {check.logAvailable
                  ? 'Log excerpt included'
                  : 'Log unavailable: name and link only'}
                {isGitHubUrl(check.url) ? (
                  <>
                    {' · '}
                    <a
                      href={check.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-brand no-underline hover:underline"
                    >
                      Open on GitHub
                      <span className="sr-only"> — {check.name} (opens GitHub in a new tab)</span>
                    </a>
                  </>
                ) : null}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {notice ? (
        <p id={noteId} role="status" className="m-0 text-small text-text-muted">
          {notice}
        </p>
      ) : null}
      {refused ? (
        <Banner tone="danger" title={refused.problem?.title ?? 'Could not send the Follow-up.'}>
          {refused.problem?.detail ?? 'Try again.'}
        </Banner>
      ) : null}
      {discard.isError ? (
        <Banner tone="danger" title="Could not discard the prepared Follow-up.">
          <span className="font-mono text-small">
            {failedRequest(
              'DELETE /api/runs/{runId}/pull-request/failing-checks/prepared',
              discard.error,
            )}
          </span>
        </Banner>
      ) : null}
      <TextField
        multiline
        mono
        label="Follow-up text"
        help="Edit it freely. At most 10 000 characters. It is sent as plain text, as you leave it here."
        value={text}
        onChange={(event) => setText(event.target.value)}
        error={problem}
        disabled={busy}
        rows={14}
        aria-describedby={notice ? noteId : undefined}
        spellCheck={false}
      />
      {!sendable ? (
        <p className="m-0 text-small text-text-muted">
          The run cannot take a Follow-up right now; see the note below. You can still discard this.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          icon={SendIcon}
          loading={send.isPending}
          disabled={busy || !sendable || included.size === 0 || problem !== undefined}
          onClick={() => send.mutate({ text: trimmed, source: 'pull_request_checks' })}
        >
          Send Follow-up
        </Button>
        <Button
          icon={Trash2Icon}
          loading={discard.isPending}
          disabled={busy}
          onClick={() => discard.mutate()}
        >
          Discard
        </Button>
      </div>
    </div>
  );
}

/**
 * "Send failing checks to the agent" (Issue #145), on the pull request card when at least one
 * Pull request check failed and the Run can take a Follow-up: the action asks the agent worker to
 * read the end of each failed check's log, then the page shows the prepared Follow-up for review
 * (deselect, edit, send or discard). It says why it cannot be offered when the Run cannot take a
 * Follow-up. There is no setting that sends failing checks by itself.
 */
export function RunFailingChecks({
  run,
  pullRequest,
}: {
  run: RunOutput;
  pullRequest: PullRequest;
}) {
  const prepare = usePrepareFailingChecks(run.id);
  const preparation = pullRequest.failingChecksPreparation;
  const ready = preparation?.state === 'ready';
  const prepared = usePreparedFollowUp(run.id, ready);
  const failed = pullRequest.checks?.some((check) => check.state === 'failed') ?? false;
  const canSend = run.followUp?.allowed === true;
  const preparing = prepare.isPending || preparation?.state === 'preparing';

  // Without a failed check there is nothing to offer, unless a draft or a failure is on show.
  if (!failed && !ready && preparation?.state !== 'failed' && !preparing) return null;

  return (
    <div
      data-slot="run-failing-checks"
      className="flex min-w-0 flex-col gap-3 border-t border-border pt-3"
    >
      {ready ? (
        prepared.data ? (
          <PreparedPreview
            key={prepared.data.text}
            run={run}
            draft={prepared.data}
            sendable={canSend}
          />
        ) : prepared.isError ? (
          <Banner tone="danger" title="Couldn't load the prepared Follow-up.">
            <span className="font-mono text-small">
              {failedRequest(PREPARED_REQUEST, prepared.error)}
            </span>
          </Banner>
        ) : (
          <p role="status" className="m-0 text-small text-text-muted">
            Loading the prepared Follow-up…
          </p>
        )
      ) : (
        <>
          {preparing ? (
            <p role="status" className="m-0 text-small text-text-muted">
              Reading the logs of the failing checks from GitHub…
            </p>
          ) : null}
          {preparation?.state === 'failed' && !preparing ? (
            <Banner tone="warning" title="The failing checks could not be prepared.">
              {preparation.error ?? 'Try again.'}
            </Banner>
          ) : null}
          {prepare.isError ? (
            <Banner tone="danger" title="Couldn't prepare the failing checks.">
              <span className="font-mono text-small">
                {failedRequest(PREPARE_REQUEST, prepare.error)}
              </span>
            </Banner>
          ) : null}
          {failed && canSend ? (
            <div className="flex min-w-0 flex-col items-start gap-1.5">
              <Button
                variant="primary"
                icon={SendIcon}
                loading={preparing}
                disabled={preparing}
                onClick={() => prepare.mutate()}
              >
                Send failing checks to the agent
              </Button>
              <p className="m-0 text-small text-text-muted">
                Prepares a Follow-up with each failed check’s name, link and the end of its log. You
                review and edit it first; nothing is sent until you send it.
              </p>
            </div>
          ) : failed ? (
            <p className="m-0 text-small text-text-muted">
              Failing checks can be sent to the agent as a Follow-up once the run can take one: see
              the note on Follow-ups below.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
