import type { NextPhase } from './next-phase.js';

/** The part of a recorded Workflow the order of its Phases is decided from. */
interface SequenceItem {
  kind: 'work' | 'review' | 'checkpoint';
}

/**
 * The order of a Workflow's Phases, decided over the plan a Run recorded and nothing else. A Phase
 * is a work or review item; a Checkpoint is not one. Only `done` of a work Phase exists so far, so
 * the Phases run one after the other.
 */
export class WorkflowSequence {
  private constructor(readonly phaseCount: number) {}

  static of(items: readonly SequenceItem[]): WorkflowSequence {
    return new WorkflowSequence(items.filter((item) => item.kind !== 'checkpoint').length);
  }

  /** The Phase after the one at `position`, or the end when it was the last. */
  after(position: number): NextPhase {
    return position + 1 < this.phaseCount
      ? { kind: 'phase', position: position + 1 }
      : { kind: 'end' };
  }
}
