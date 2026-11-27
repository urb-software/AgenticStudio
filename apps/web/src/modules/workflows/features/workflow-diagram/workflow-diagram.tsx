import Link from 'next/link';
import { Badge } from '@/shared/components/badge';
import { cn } from '@/shared/lib/utils';
import type { WorkflowItemOutput } from '../../../../platform/api';
import { agentHref } from '../../components/workflow-links';
import { sendBackPaths, sendBackSentence, type SendBackPath } from './flow-model';

const PROVIDER_LABEL = { claude_code: 'Claude Code', codex: 'Codex' } as const;

const LANE_BASE_PX = 12;
const LANE_STEP_PX = 12;

type Phase = Exclude<WorkflowItemOutput, { kind: 'checkpoint' }>;

function whyNotUsable(phase: Phase): string | null {
  if (phase.usable) return null;
  if (phase.agentState === 'missing') return 'This agent does not exist.';
  if (phase.agentState === 'invalid') return 'This agent is not valid.';
  return 'The Provider of this agent is not available now.';
}

/**
 * One send-back path as it passes a card: the line leaves the review card, runs down the right
 * side and enters the work card with an arrowhead. Plain CSS, hidden from assistive technology;
 * the sentence under the review phase says the same.
 */
function SendBackLine({ path, index }: { path: SendBackPath; index: number }) {
  const offset = LANE_BASE_PX + path.lane * LANE_STEP_PX;
  const isTarget = index === path.target;
  const isReview = index === path.review;
  return (
    <span
      aria-hidden="true"
      data-slot="send-back-line"
      style={{ right: `-${offset}px`, width: `${offset}px` }}
      className={cn(
        'pointer-events-none absolute border-dashed border-brand',
        isTarget && 'top-1/2 -bottom-4 rounded-tr-md border-t-2 border-r-2',
        isReview && '-top-4 bottom-1/2 rounded-br-md border-r-2 border-b-2',
        !isTarget && !isReview && '-top-4 -bottom-4 border-r-2',
      )}
    >
      {isTarget ? (
        <span className="absolute top-0 left-0 size-0 -translate-y-1/2 border-y-[5px] border-r-[8px] border-y-transparent border-r-brand" />
      ) : null}
    </span>
  );
}

function PhaseCard({ phase, sentence }: { phase: Phase; sentence: string | null }) {
  const problem = whyNotUsable(phase);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-code font-semibold break-all">{phase.id}</span>
        <Badge>{phase.kind === 'work' ? 'Work' : 'Review'}</Badge>
        {problem ? (
          <span className="text-caption font-medium text-run-failed">Not usable</span>
        ) : null}
      </div>
      <p className="m-0 flex flex-wrap items-baseline gap-x-1.5 text-small">
        <span className="text-text-muted">Agent</span>
        {phase.agentState === 'missing' ? (
          <span className="font-mono text-code break-all">{phase.agent}</span>
        ) : (
          <Link href={agentHref(phase.agent)} className="font-mono text-code break-all">
            {phase.agent}
          </Link>
        )}
        {phase.provider ? (
          <span className="text-text-muted">· {PROVIDER_LABEL[phase.provider]}</span>
        ) : null}
      </p>
      {problem ? <p className="m-0 text-small text-run-failed">{problem}</p> : null}
      {sentence ? <p className="m-0 text-small text-text-muted">{sentence}</p> : null}
    </div>
  );
}

/**
 * The Workflow as a vertical flow: the ordered list of its phases and checkpoints, each phase
 * with its kind and agent, a checkpoint drawn apart, and the way back from a review to the work
 * before it. The list is the text equivalent of the picture: there is one source for both.
 */
export function WorkflowDiagram({
  items,
  sendBacks,
}: {
  items: WorkflowItemOutput[];
  sendBacks: number;
}) {
  const paths = sendBackPaths(items);
  const gutter = paths.length === 0 ? 0 : LANE_BASE_PX + paths.length * LANE_STEP_PX;
  return (
    <ol
      role="list"
      aria-label="Phases and checkpoints in order"
      style={{ paddingRight: `${gutter}px` }}
      className="m-0 flex list-none flex-col p-0"
    >
      {items.map((item, index) => {
        const here = paths.filter((path) => index >= path.target && index <= path.review);
        const back = paths.find((path) => path.review === index);
        const targetId = back ? items[back.target]?.id : undefined;
        return (
          <li key={`${index}:${item.id}`} className="flex gap-3 pb-4 last:pb-0">
            <div className="flex flex-col items-center" aria-hidden="true">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface text-caption font-medium text-text-muted">
                {index + 1}
              </span>
              {index < items.length - 1 ? <span className="w-px flex-1 bg-border-strong" /> : null}
            </div>
            <div
              data-kind={item.kind}
              className={cn(
                'relative min-w-0 flex-1 rounded-md border px-3 py-2.5',
                item.kind === 'checkpoint'
                  ? 'border-dashed border-run-awaiting bg-run-awaiting-soft'
                  : 'border-border bg-surface',
              )}
            >
              {item.kind === 'checkpoint' ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-code font-semibold break-all">{item.id}</span>
                    <Badge>Checkpoint</Badge>
                  </div>
                  <p className="m-0 text-small text-text-muted">
                    The Run waits here until you continue or stop it.
                  </p>
                  <p className="m-0 text-small break-words whitespace-pre-wrap">{item.text}</p>
                </div>
              ) : (
                <PhaseCard
                  phase={item}
                  sentence={targetId === undefined ? null : sendBackSentence(targetId, sendBacks)}
                />
              )}
              {here.map((path) => (
                <SendBackLine key={path.lane} path={path} index={index} />
              ))}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
