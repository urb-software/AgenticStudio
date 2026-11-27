import type { NextPhase, PhaseOutcome } from './next-phase.js';

/** The part of a recorded Workflow the order of its Phases is decided from. */
interface SequenceItem {
  kind: 'work' | 'review' | 'checkpoint';
}

/**
 * The order of a Workflow's Phases over the recorded plan alone; a Checkpoint is no Phase. `done`
 * and `approved` go on; `changes_requested` ends the Workflow, where a send-back will be decided.
 */
export class WorkflowSequence {
  private constructor(readonly phaseCount: number) {}

  static of(items: readonly SequenceItem[]): WorkflowSequence {
    return new WorkflowSequence(items.filter((item) => item.kind !== 'checkpoint').length);
  }

  /** The Phase after the one at `position` for how it ended, or the end of the Workflow. */
  after(position: number, outcome: PhaseOutcome = 'done'): NextPhase {
    if (outcome === 'changes_requested') return { kind: 'end' };
    return position + 1 < this.phaseCount
      ? { kind: 'phase', position: position + 1 }
      : { kind: 'end' };
  }
}
