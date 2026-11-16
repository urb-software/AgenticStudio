'use client';

import { MessageCircleQuestionIcon, SendIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { TextField } from '@/shared/components/text-field';
import { formatExactTime } from '@/shared/lib/relative-time';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import {
  ApiError,
  type RunMessageOutput,
  type RunOutput,
  type RunQuestionOutput,
} from '../../../../platform/api';
import { useAnswerRun, useRunSteps } from '../../api/runs-queries';
import { FAILURE_MESSAGE, RUN_STATE_VIEW } from '../../components/run-presentation';

/** Longest answer the API takes, in characters (the API's limit is authoritative). */
const ANSWER_MAX_LENGTH = 10_000;

const KIND_LABEL: Record<RunMessageOutput['kind'], string> = {
  task: 'Task',
  question: 'Question',
  answer: 'Answer',
  follow_up: 'Follow-up',
  part_end: 'Part ended',
};

const ROLE_LABEL: Record<RunMessageOutput['role'], string> = {
  operator: 'You',
  agent: 'Agent',
  studio: 'Studio',
};

const DELIVERY_WORDS: Record<
  NonNullable<NonNullable<RunMessageOutput['end']>['delivery']>,
  string
> = {
  delivered: 'the draft pull request was delivered',
  none: 'no changes, nothing pushed',
  failed: 'the delivery failed',
};

/**
 * Where a part of the Run ended before a Follow-up reopened it (review S1 of #150): its state,
 * why (the failure or cancellation, as plain text) and its delivery. `part` is 0 for the first
 * part, n for Follow-up n.
 */
function PartEnd({ message, part }: { message: RunMessageOutput; part: number }) {
  const end = message.end;
  if (!end) return null;
  const which = part === 0 ? 'The first part' : `Follow-up ${part}`;
  const reason = end.failureCode ? FAILURE_MESSAGE[end.failureCode] : undefined;
  return (
    <li
      data-slot="run-part-end"
      className="flex min-w-0 flex-col gap-1 border-t border-border-strong pt-2 text-small"
    >
      <p className="m-0 font-semibold text-text-muted">
        {which} ended: {RUN_STATE_VIEW[end.state].label}
        {end.delivery ? ` · ${DELIVERY_WORDS[end.delivery]}` : null}
      </p>
      {reason ? <p className="m-0 text-text-muted">{reason}</p> : null}
      {message.text ? (
        <p className="m-0 font-mono text-code break-words whitespace-pre-wrap text-text-muted">
          {message.text}
        </p>
      ) : null}
    </li>
  );
}

/** The options a question offered, the recommended one marked. Plain text only. */
function Options({
  options,
  recommendation,
}: {
  options: readonly string[];
  recommendation: string | undefined;
}) {
  return (
    <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0" aria-label="Options offered">
      {/* Keyed by position: the agent may offer the same text twice (Issue #115). */}
      {options.map((option, index) => (
        <li
          key={`${index}-${option}`}
          className="flex flex-wrap items-center gap-2 text-small text-text-muted"
        >
          <span className="break-words whitespace-pre-wrap">{option}</span>
          {option === recommendation ? <RecommendedMark /> : null}
        </li>
      ))}
    </ul>
  );
}

function RecommendedMark() {
  return (
    <span className="rounded-sm border border-border-strong px-1.5 text-caption font-medium text-text-muted">
      Recommended
    </span>
  );
}

/** One turn of the conversation: who, what kind, when, and the text as plain text. */
function Message({
  message,
  label,
  children,
}: {
  message: Pick<RunMessageOutput, 'role' | 'text' | 'at' | 'options' | 'recommendation'> & {
    kind?: RunMessageOutput['kind'];
  };
  /** Who and what kind, e.g. "You · Follow-up 2"; by default from the message's role and kind. */
  label?: string;
  /** What goes under the text, e.g. the commit a bring-up-to-date request merged (Issue #147). */
  children?: ReactNode;
}) {
  label ??= `${ROLE_LABEL[message.role]} · ${KIND_LABEL[message.kind ?? 'answer']}`;
  const agent = message.role === 'agent';
  return (
    <li
      data-slot="run-message"
      className={cn(
        'flex min-w-0 flex-col gap-1 rounded-md border px-3 py-2.5',
        agent ? 'border-border bg-bg-subtle' : 'border-border bg-surface',
      )}
    >
      <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-caption text-text-dim">
        <span className="font-medium text-text-muted">{label}</span>
        <time dateTime={message.at} className="tabular-nums">
          {formatExactTime(new Date(message.at))}
        </time>
      </p>
      {/* The agent's text (and the operator's) is rendered as text: never markup. */}
      {message.text === '' ? null : (
        <p className="m-0 break-words whitespace-pre-wrap">{message.text}</p>
      )}
      {children}
      {message.options ? (
        <Options options={message.options} recommendation={message.recommendation} />
      ) : null}
    </li>
  );
}

/**
 * Between two turns: the Run step that ran, whose log is in the Log card below. The link shows
 * that step in the log (Issue #115); without it loaded, it goes to the Log card.
 */
function StepDivider({
  index,
  onShowStep,
}: {
  index: number;
  onShowStep: ((index: number) => boolean) | undefined;
}) {
  return (
    <li className="flex items-center gap-2 text-caption text-text-dim">
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <a
        href="#run-log-title"
        onClick={(event) => {
          if (onShowStep?.(index)) event.preventDefault();
        }}
        className="text-text-muted no-underline hover:underline"
      >
        Run step {index} · log below
      </a>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </li>
  );
}

/** Where a Follow-up begins a new part of the Run (Issue #141); the part before it has ended. */
function FollowUpDivider({ number }: { number: number }) {
  return (
    <li className="flex items-center gap-2 pt-1 text-caption font-semibold text-text-muted">
      <span aria-hidden="true" className="h-px flex-1 bg-border-strong" />
      <span>Follow-up {number} begins</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border-strong" />
    </li>
  );
}

/**
 * The Run's conversation (Issue #103): the Task, each question of the agent and each answer of
 * the operator, in order, with the Run step that ran between them (its log is in the Log card).
 * Issue #141: each Follow-up begins a new part, marked by a divider, and each part's result
 * (the summary of a step that ended `done`) stays visible as the agent's turn where it ended.
 * The step numbers come from the stored step results: the k-th question ends the k-th step
 * that asked; results are placed by the time they were reported. Until those are loaded, a
 * question's step is counted from the questions before it.
 */
export function RunConversation({
  runId,
  messages,
  onShowStep,
}: {
  runId: string;
  messages: readonly RunMessageOutput[];
  /** Shows Run step `index` in the log; false when it cannot (the link then goes to the log). */
  onShowStep?: (index: number) => boolean;
}) {
  const { data: steps } = useRunSteps(runId);
  const ordered = steps ? [...steps.values()].sort((a, b) => a.index - b.index) : [];
  const asked = ordered.filter((step) => step.outcome === 'needs_input');
  const done = ordered.filter((step) => step.outcome === 'done');
  const items: ReactNode[] = [];
  let questions = 0;
  let followUps = 0;
  let results = 0;
  const pushResult = (step: (typeof done)[number]) => {
    items.push(
      <StepDivider key={`step-${step.index}`} index={step.index} onShowStep={onShowStep} />,
    );
    items.push(
      <Message
        key={`result-${step.index}`}
        message={{ role: 'agent', text: step.summary, at: step.reportedAt }}
        label="Agent · Result"
      />,
    );
  };
  messages.forEach((message, i) => {
    // Results reported before this turn come first (the Task always leads).
    if (message.kind !== 'task') {
      while (results < done.length && done[results]!.reportedAt <= message.at) {
        pushResult(done[results]!);
        results += 1;
      }
    }
    // A question ends a Run step: it ran after the Task, an answer or a Follow-up.
    if (message.kind === 'question') {
      questions += 1;
      const index = asked[questions - 1]?.index ?? questions;
      items.push(<StepDivider key={`step-${index}`} index={index} onShowStep={onShowStep} />);
    }
    if (message.kind === 'part_end') {
      items.push(<PartEnd key={`${i}-part-end`} message={message} part={followUps} />);
      return;
    }
    if (message.kind === 'follow_up') {
      followUps += 1;
      items.push(<FollowUpDivider key={`follow-up-${followUps}`} number={followUps} />);
      // Issue #147: a request to bring the Run branch up to date is a Follow-up of its own source.
      const bringUp = message.source === 'bring_up_to_date';
      items.push(
        <Message
          key={`${i}-${message.kind}`}
          message={message}
          label={`You · Follow-up ${followUps}${
            // Issue #145: where a prepared Follow-up came from; Issue #147: a bring-up request.
            bringUp
              ? ' · Bring up to date'
              : message.source === 'pull_request_checks'
                ? ' · prepared from Pull request checks'
                : ''
          }`}
        >
          {bringUp ? (
            <>
              {message.text === '' ? (
                <p className="m-0 text-small text-text-muted">No note.</p>
              ) : null}
              {message.mergedCommit ? (
                <p className="m-0 text-small text-text-muted">
                  Merged the integration branch commit{' '}
                  <code className="font-mono text-code" title={message.mergedCommit}>
                    {message.mergedCommit.slice(0, 7)}
                  </code>
                  .
                </p>
              ) : null}
            </>
          ) : null}
        </Message>,
      );
      return;
    }
    items.push(<Message key={`${i}-${message.kind}`} message={message} />);
  });
  for (; results < done.length; results += 1) pushResult(done[results]!);
  return (
    <Card aria-labelledby="run-conversation-title">
      <CardHeader>
        <CardTitle id="run-conversation-title">Conversation</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="m-0 flex list-none flex-col gap-2.5 p-0" aria-label="Conversation">
          {items}
        </ol>
      </CardContent>
    </Card>
  );
}

/** Server field errors (422 `errors[]`) for the answer. */
function answerError(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.status !== 422) return undefined;
  return error.problem?.errors?.[0]?.message ?? error.problem?.detail;
}

/**
 * The agent's open question and the answer form (Issue #103), in the operator's colour (amber
 * means "you"): the question as plain text, the options as buttons (the recommended one marked)
 * that fill the answer, and a free-text answer. Sending stores the answer and queues the Run to
 * resume; while it is sent, and once the Run no longer waits, the form takes no input.
 */
export function AnswerQuestion({ run, question }: { run: RunOutput; question: RunQuestionOutput }) {
  const [text, setText] = useState('');
  const [localError, setLocalError] = useState<string | undefined>();
  const answer = useAnswerRun(run.id);
  // Another Run's page reuses this form (review Std-2 of #128): nothing typed or refused for one
  // Run carries over to the next. The reset happens during render, before anything is shown.
  const [formRun, setFormRun] = useState(run.id);
  if (formRun !== run.id) {
    setFormRun(run.id);
    setText('');
    setLocalError(undefined);
  }
  const { reset } = answer;
  useEffect(() => reset(), [run.id, reset]);
  const titleId = useId();
  const waiting = run.state === 'waiting_for_operator';
  const disabled = !waiting || answer.isPending;
  const fieldError = localError ?? answerError(answer.error);
  const refused =
    answer.error instanceof ApiError && answer.error.status !== 422 ? answer.error : undefined;

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed === '') {
      setLocalError('Enter an answer, or choose one of the options.');
      return;
    }
    if (trimmed.length > ANSWER_MAX_LENGTH) {
      setLocalError(`Use at most ${ANSWER_MAX_LENGTH} characters.`);
      return;
    }
    setLocalError(undefined);
    answer.mutate({ text: trimmed });
  }

  return (
    <section
      aria-labelledby={titleId}
      data-slot="answer-question"
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-run-awaiting/35 bg-run-awaiting-soft p-4"
    >
      <h2
        id={titleId}
        className="m-0 flex items-center gap-2 text-body font-semibold text-run-awaiting"
      >
        <MessageCircleQuestionIcon aria-hidden="true" className="size-4" />
        The agent needs your decision
      </h2>
      <p className="m-0 break-words whitespace-pre-wrap text-text">{question.text}</p>
      {refused ? (
        <Banner tone="danger" title={refused.problem?.title ?? 'Could not send the answer.'}>
          {refused.problem?.detail ?? 'Try again.'}
        </Banner>
      ) : null}
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-3" noValidate>
        {question.options && question.options.length > 0 ? (
          <div role="group" aria-label="Options" className="flex flex-wrap gap-2">
            {question.options.map((option, index) => (
              <Button
                key={`${index}-${option}`}
                type="button"
                variant="secondary"
                aria-pressed={text.trim() === option}
                disabled={disabled}
                onClick={() => {
                  setText(option);
                  setLocalError(undefined);
                }}
                className="h-auto min-h-9 max-w-full py-1.5 text-left break-words whitespace-normal"
              >
                <span className="min-w-0">{option}</span>
                {option === question.recommendation ? <RecommendedMark /> : null}
              </Button>
            ))}
          </div>
        ) : null}
        <TextField
          multiline
          label="Your answer"
          help="Choose an option or write your own answer. The agent continues with it."
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setLocalError(undefined);
          }}
          error={fieldError}
          disabled={disabled}
          rows={3}
        />
        <div>
          <Button
            type="submit"
            variant="primary"
            icon={SendIcon}
            loading={answer.isPending}
            disabled={disabled}
          >
            Send answer
          </Button>
        </div>
      </form>
    </section>
  );
}
