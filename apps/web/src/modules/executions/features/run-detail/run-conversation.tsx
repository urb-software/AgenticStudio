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
import { useAnswerRun } from '../../api/runs-queries';

/** Longest answer the API takes, in characters (the API's limit is authoritative). */
const ANSWER_MAX_LENGTH = 10_000;

const KIND_LABEL: Record<RunMessageOutput['kind'], string> = {
  task: 'Task',
  question: 'Question',
  answer: 'Answer',
};

const ROLE_LABEL: Record<RunMessageOutput['role'], string> = {
  operator: 'You',
  agent: 'Agent',
};

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
      {options.map((option) => (
        <li key={option} className="flex flex-wrap items-center gap-2 text-small text-text-muted">
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
function Message({ message }: { message: RunMessageOutput }) {
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
        <span className="font-medium text-text-muted">
          {ROLE_LABEL[message.role]} · {KIND_LABEL[message.kind]}
        </span>
        <time dateTime={message.at} className="tabular-nums">
          {formatExactTime(new Date(message.at))}
        </time>
      </p>
      {/* The agent's text (and the operator's) is rendered as text: never markup. */}
      <p className="m-0 break-words whitespace-pre-wrap">{message.text}</p>
      {message.options ? (
        <Options options={message.options} recommendation={message.recommendation} />
      ) : null}
    </li>
  );
}

/** Between two turns: the Run step that ran, whose log is in the Log card below. */
function StepDivider({ index }: { index: number }) {
  return (
    <li className="flex items-center gap-2 text-caption text-text-dim">
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <a href="#run-log-title" className="text-text-muted no-underline hover:underline">
        Run step {index} · log below
      </a>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </li>
  );
}

/**
 * The Run's conversation (Issue #103): the Task, each question of the agent and each answer of
 * the operator, in order, with the Run step that ran between them (its log is in the Log card).
 * The question is the end of Run step n; the answer resumes the session as step n + 1.
 */
export function RunConversation({ messages }: { messages: readonly RunMessageOutput[] }) {
  let step = 0;
  const items: ReactNode[] = [];
  messages.forEach((message, i) => {
    // A question ends a Run step: it ran after the Task or the previous answer.
    if (message.kind === 'question') {
      step += 1;
      items.push(<StepDivider key={`step-${step}`} index={step} />);
    }
    items.push(<Message key={`${i}-${message.kind}`} message={message} />);
  });
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
            {question.options.map((option) => (
              <Button
                key={option}
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
