import { WORKFLOW_DEFAULT_SEND_BACKS } from '@agentic-studio/agent-definitions';
import type { NextStep, PhaseOutcome } from './next-step.js';
import type { PhaseNext } from './phase-next.js';
import type { SendBackState } from './send-back-state.js';

/** The part of a recorded Workflow the order of its items is decided from. */
interface SequenceItem {
  kind: 'work' | 'review' | 'checkpoint';
}

/** The most send-backs a Run may use: the Workflow format's default, and its highest value. */
const MOST_SEND_BACKS = WORKFLOW_DEFAULT_SEND_BACKS;

/**
 * The order of a Workflow's items over the recorded plan alone; a Checkpoint is no Phase. `done`
 * and `approved` go on. `changes_requested` sends the work back to the nearest work Phase before
 * the review while the Run's count is below the recorded limit, and ends the Workflow at it.
 */
export class WorkflowSequence {
  private constructor(
    private readonly items: readonly SequenceItem[],
    readonly sendBackLimit: number,
  ) {}

  /**
   * `sendBacks` is the number the Run recorded: absent means the default, and no number is ever
   * higher than {@link MOST_SEND_BACKS} or lower than none.
   */
  static of(items: readonly SequenceItem[], sendBacks?: number | null): WorkflowSequence {
    const limit =
      sendBacks === undefined || sendBacks === null || Number.isNaN(sendBacks)
        ? MOST_SEND_BACKS
        : Math.min(Math.max(Math.trunc(sendBacks), 0), MOST_SEND_BACKS);
    return new WorkflowSequence(
      items.map(({ kind }) => ({ kind })),
      limit,
    );
  }

  get phaseCount(): number {
    return this.items.filter((item) => item.kind !== 'checkpoint').length;
  }

  /** Where the Workflow starts: its first Phase, or a Checkpoint that comes before it. */
  first(): NextStep {
    return this.from(0);
  }

  /**
   * What follows the Phase at `position` for how it ended: a Checkpoint, a Phase, a send-back or
   * the end. The work Phase a send-back went to returns straight to the review that sent it.
   */
  after(
    position: number,
    outcome: PhaseOutcome = 'done',
    state: SendBackState = { used: 0 },
  ): PhaseNext {
    if (outcome === 'changes_requested') return this.afterChangesRequested(position, state.used);
    const { returnTo } = state;
    if (
      outcome === 'done' &&
      returnTo !== undefined &&
      returnTo !== null &&
      returnTo > position &&
      this.phaseKinds()[position] === 'work' &&
      this.phaseKinds()[returnTo] === 'review'
    ) {
      return { kind: 'phase', position: returnTo };
    }
    let seen = -1;
    for (const [index, item] of this.items.entries()) {
      if (item.kind !== 'checkpoint') seen += 1;
      if (seen === position) return this.from(index + 1);
    }
    return { kind: 'end' };
  }

  private afterChangesRequested(position: number, used: number): PhaseNext {
    if (this.phaseKinds()[position] !== 'review' || used >= this.sendBackLimit) {
      return { kind: 'end' };
    }
    const kinds = this.phaseKinds();
    for (let at = position - 1; at >= 0; at -= 1) {
      if (kinds[at] === 'work') return { kind: 'send_back', position: at };
    }
    return { kind: 'end' };
  }

  private phaseKinds(): readonly SequenceItem['kind'][] {
    return this.items.filter((item) => item.kind !== 'checkpoint').map((item) => item.kind);
  }

  /** What follows the Checkpoint at place `item` among the items. */
  afterCheckpoint(item: number): NextStep {
    return this.from(item + 1);
  }

  private from(index: number): NextStep {
    const next = this.items[index];
    if (next === undefined) return { kind: 'end' };
    if (next.kind === 'checkpoint') return { kind: 'checkpoint', item: index };
    return {
      kind: 'phase',
      position: this.items.slice(0, index).filter((item) => item.kind !== 'checkpoint').length,
    };
  }
}
