'use client';

import { MessageSquareTextIcon, SendIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { SegmentedControl } from '@/shared/components/segmented-control';
import { TextField } from '@/shared/components/text-field';
import { formatExactTime } from '@/shared/lib/relative-time';
import { Button } from '@/shared/ui/button';
import {
  ApiError,
  type LoadReviewCommentsRequest,
  type ReviewCommentOutput,
  type ReviewCommentsOutput,
  type RunOutput,
} from '../../../../platform/api';
import {
  useAgentWorker,
  useFollowUpRun,
  useLoadReviewComments,
  useReviewComments,
} from '../../api/runs-queries';
import { failedRequest } from '../../components/failed-request';
import { FOLLOW_UP_MAX_LENGTH } from '../../components/follow-up-limits';
import {
  commentKindLabel,
  commentLocation,
  commentSection,
  preparedText,
} from '../../components/review-comments-text';

const LOAD_REQUEST = 'POST /api/runs/{runId}/pull-request/review-comments/load';
const READ_REQUEST = 'GET /api/runs/{runId}/pull-request/review-comments';

type Scope = LoadReviewCommentsRequest['scope'];

const SCOPE_OPTIONS = [
  { value: 'since_last_result', label: 'New since the latest result' },
  { value: 'unresolved', label: 'All unresolved' },
] as const satisfies readonly { value: Scope; label: string }[];

const SCOPE_WORDS: Record<Scope, string> = {
  since_last_result: 'written since the latest result',
  unresolved: 'unresolved',
};

/** The text without a comment's section, and without the blank lines it leaves behind. */
function withoutSection(text: string, section: string): string {
  return text
    .replace(section, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

/**
 * One comment: who wrote it, what kind it is and where, when, the diff lines around an inline
 * comment, and its text. Everything is shown as plain text: the comment is untrusted, so markup,
 * HTML and links in it are never rendered or followed.
 */
function CommentRow({
  comment,
  checked,
  disabled,
  onChange,
}: {
  comment: ReviewCommentOutput;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  const where = commentLocation(comment);
  return (
    <li
      data-slot="review-comment"
      className="flex min-w-0 items-start gap-2.5 border-t border-border py-2.5 first:border-t-0"
    >
      <input
        type="checkbox"
        className="mt-1 size-4 shrink-0 accent-brand pointer-coarse:size-5"
        checked={checked}
        disabled={disabled}
        aria-labelledby={`${id}-head`}
        aria-describedby={`${id}-body`}
        onChange={(event) => onChange(event.target.checked)}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p id={`${id}-head`} className="m-0 text-small font-medium break-words text-text">
          {commentKindLabel(comment)} by <span className="font-mono">{comment.author}</span>
          {where ? <span className="font-normal text-text-muted"> {where}</span> : null}
          <time
            dateTime={comment.createdAt}
            className="block text-caption font-normal text-text-dim tabular-nums"
          >
            {formatExactTime(new Date(comment.createdAt))}
          </time>
        </p>
        <div id={`${id}-body`} className="flex min-w-0 flex-col gap-1.5">
          {comment.diffContext ? (
            <pre
              role="region"
              aria-label="The diff around the comment"
              tabIndex={0}
              className="m-0 max-w-full overflow-x-auto rounded-sm bg-surface-raised p-2 font-mono text-code text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              {comment.diffContext}
            </pre>
          ) : null}
          <p className="m-0 font-mono text-code break-words whitespace-pre-wrap text-text">
            {comment.text.trim() === '' ? '(no text)' : comment.text}
          </p>
          {comment.textCut ? (
            <p className="m-0 text-caption text-text-muted">
              The comment was cut to its size limit.
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/**
 * The loaded comments for review (Issue #146): the operator's own are listed first and selected,
 * everyone else's sit in a collapsed section and are unselected. Selecting adds a comment's part
 * to the prepared text, deselecting takes it out (a part the operator edited stays, and is said
 * so). Nothing is sent until "Send Follow-up".
 */
function CommentsPreview({
  run,
  data,
  sendable,
}: {
  run: RunOutput;
  data: ReviewCommentsOutput;
  /** Whether the Run can take the Follow-up now. */
  sendable: boolean;
}) {
  const noteId = useId();
  const mine = data.comments.filter((comment) => comment.byOperator);
  const others = data.comments.filter((comment) => !comment.byOperator);
  const [selected, setSelected] = useState(() => new Set(mine.map((comment) => comment.id)));
  const [text, setText] = useState(() => preparedText(mine));
  const [notice, setNotice] = useState<string | undefined>();
  const send = useFollowUpRun(run.id);
  const busy = send.isPending;
  const trimmed = text.trim();
  const tooLong = trimmed.length > FOLLOW_UP_MAX_LENGTH;
  const refused =
    send.error instanceof ApiError && send.error.status !== 422 ? send.error : undefined;
  const fieldError =
    send.error instanceof ApiError && send.error.status === 422
      ? (send.error.problem?.errors?.[0]?.message ?? send.error.problem?.detail)
      : undefined;
  const problem = tooLong
    ? `Use at most ${FOLLOW_UP_MAX_LENGTH} characters: leave out a comment or shorten the text.`
    : trimmed === ''
      ? 'Enter a Follow-up.'
      : fieldError;

  function toggle(comment: ReviewCommentOutput, checked: boolean) {
    const section = commentSection(comment);
    const next = new Set(selected);
    if (checked) {
      next.add(comment.id);
      if (!text.includes(section)) setText(`${text.trimEnd()}\n\n${section}`);
      setNotice(undefined);
    } else {
      next.delete(comment.id);
      if (text.includes(section)) {
        setText(withoutSection(text, section));
        setNotice(undefined);
      } else {
        setNotice(
          `The part of the text for the comment by ${comment.author} was edited, so it stays in the text: remove it there yourself.`,
        );
      }
    }
    setSelected(next);
  }

  const row = (comment: ReviewCommentOutput) => (
    <CommentRow
      key={comment.id}
      comment={comment}
      checked={selected.has(comment.id)}
      disabled={busy}
      onChange={(checked) => toggle(comment, checked)}
    />
  );

  return (
    <div data-slot="review-comments-preview" className="flex min-w-0 flex-col gap-3">
      <Banner tone="info" title="Review before anything is sent.">
        Anyone can comment on a public pull request, and a comment can be written to mislead an
        agent. Comments are shown as plain text, and only the ones you select, in the text you edit
        below, reach the agent when you send.
      </Banner>
      {data.operatorLogin ? (
        <p className="m-0 text-small text-text-muted">
          Showing comments by <span className="font-mono text-text">{data.operatorLogin}</span>{' '}
          first and selected.
        </p>
      ) : (
        <p className="m-0 text-small text-text-muted">
          No comment is selected: the operator’s GitHub login is not configured. Set{' '}
          <code className="font-mono text-code">STUDIO_OPERATOR_GITHUB_LOGIN</code> in the API’s
          environment and restart it to have your own comments selected.
        </p>
      )}
      {data.truncated ? (
        <p className="m-0 text-small text-text-muted">
          Some comments are not shown, or were cut: there are more than the limits allow (100
          comments, 8 KiB each). Open the pull request on GitHub for the rest.
        </p>
      ) : null}
      {mine.length > 0 ? (
        <section aria-label="Comments by you" className="flex min-w-0 flex-col">
          <h3 className="m-0 mb-1 text-small font-medium text-text">Your comments</h3>
          <ul className="m-0 flex list-none flex-col p-0">{mine.map(row)}</ul>
        </section>
      ) : null}
      {others.length > 0 ? (
        <details
          data-slot="review-comments-others"
          className="min-w-0 rounded-md border border-border px-3 py-1"
        >
          <summary className="min-h-9 cursor-pointer py-1.5 text-small font-medium text-text">
            Comments by others ({others.length}), not selected
          </summary>
          <p className="m-0 pb-1 text-small text-text-muted">
            Include one only if you trust it: its author is shown with it.
          </p>
          <ul className="m-0 flex list-none flex-col p-0">{others.map(row)}</ul>
        </details>
      ) : null}
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
      <TextField
        multiline
        mono
        label="Follow-up text"
        help="Edit it freely and add your own note after the comments. At most 10 000 characters. It is sent as plain text, as you leave it here."
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
          The run cannot take a Follow-up right now; see the note below.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          icon={SendIcon}
          loading={busy}
          disabled={busy || !sendable || problem !== undefined || selected.size === 0}
          onClick={() =>
            send.mutate({
              text: trimmed,
              source: 'review_comments',
              reviewCommentIds: data.comments
                .filter((comment) => selected.has(comment.id))
                .map((comment) => comment.id),
            })
          }
        >
          Send Follow-up
        </Button>
        {selected.size === 0 ? (
          <p className="m-0 self-center text-small text-text-muted">Select at least one comment.</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "Load review comments" (Issue #146), on the pull request card while the Run can take a
 * Follow-up: it asks the agent worker to read the pull request's review summaries, inline
 * comments and conversation comments through the Agent account (by default those written since
 * the latest result; or all unresolved), then shows them for review: the operator's own selected,
 * everyone else's collapsed and unselected, an editable prepared text, and "Send Follow-up".
 * Loading starts no agent and sends nothing, and nothing is posted back to GitHub. There is no
 * setting that sends comments by itself.
 */
export function RunReviewComments({ run }: { run: RunOutput }) {
  const canSend = run.followUp?.allowed === true;
  const comments = useReviewComments(run.id, canSend);
  const load = useLoadReviewComments(run.id);
  const worker = useAgentWorker();
  const [scope, setScope] = useState<Scope>('since_last_result');
  const scopeLabelId = useId();
  if (!canSend) return null;

  const data = comments.data;
  const loading = load.isPending || data?.loading === true;
  const noWorker = loading && worker.data?.connected === false;
  const hasSet = data?.loadedAt !== undefined;

  return (
    <div
      data-slot="run-review-comments"
      className="flex min-w-0 flex-col gap-3 border-t border-border pt-3"
    >
      <div className="flex min-w-0 flex-col items-start gap-2">
        <p id={scopeLabelId} className="m-0 text-small font-medium text-text">
          Review comments
        </p>
        <SegmentedControl
          options={SCOPE_OPTIONS}
          value={scope}
          onChange={setScope}
          aria-labelledby={scopeLabelId}
          disabled={loading}
        />
        <Button
          icon={MessageSquareTextIcon}
          loading={loading}
          disabled={loading}
          onClick={() => load.mutate({ scope })}
        >
          {hasSet ? 'Load review comments again' : 'Load review comments'}
        </Button>
        <p className="m-0 text-small text-text-muted">
          Reads the comments on the pull request from GitHub. You choose which ones to send; nothing
          is sent to an agent, and nothing is posted to GitHub.
        </p>
      </div>
      {loading ? (
        <p role="status" className="m-0 text-small text-text-muted">
          Loading the review comments from GitHub…
        </p>
      ) : null}
      {noWorker ? (
        <Banner tone="warning" title="No agent worker is connected.">
          The comments are read by the agent worker. Start it; the load continues when it connects.
        </Banner>
      ) : null}
      {data?.error && !loading ? (
        <Banner tone="warning" title="The review comments could not be loaded.">
          {data.error}
          {hasSet ? ' The comments loaded before are shown.' : ''}
        </Banner>
      ) : null}
      {load.isError ? (
        <Banner tone="danger" title="Couldn't load the review comments.">
          <span className="font-mono text-small">{failedRequest(LOAD_REQUEST, load.error)}</span>
        </Banner>
      ) : null}
      {comments.isError ? (
        <Banner tone="danger" title="Couldn't read the loaded review comments.">
          <span className="font-mono text-small">
            {failedRequest(READ_REQUEST, comments.error)}
          </span>
        </Banner>
      ) : null}
      {data && hasSet && !loading ? (
        data.comments.length === 0 ? (
          <p role="status" className="m-0 text-small text-text-muted">
            No review comments found: none that are {SCOPE_WORDS[data.scope ?? 'unresolved']}.
          </p>
        ) : (
          <CommentsPreview key={data.loadedAt} run={run} data={data} sendable={canSend} />
        )
      ) : null}
    </div>
  );
}
