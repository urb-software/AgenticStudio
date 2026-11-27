import type { NextStep } from './next-step.js';

/** The part of a recorded Workflow the order of its items is decided from. */
interface SequenceItem {
  kind: 'work' | 'review' | 'checkpoint';
}

/**
 * The order of a Workflow's items, decided over the plan a Run recorded and nothing else. A Phase
 * is a work or review item; a Checkpoint is not one. Only `done` of a work Phase exists so far, so
 * the items follow one another.
 */
export class WorkflowSequence {
  private constructor(private readonly items: readonly SequenceItem[]) {}

  static of(items: readonly SequenceItem[]): WorkflowSequence {
    return new WorkflowSequence(items.map(({ kind }) => ({ kind })));
  }

  get phaseCount(): number {
    return this.items.filter((item) => item.kind !== 'checkpoint').length;
  }

  /** Where the Workflow starts: its first Phase, or a Checkpoint that comes before it. */
  first(): NextStep {
    return this.from(0);
  }

  /** What follows the Phase at `position`: a Checkpoint, the next Phase, or the end. */
  after(position: number): NextStep {
    let seen = -1;
    for (const [index, item] of this.items.entries()) {
      if (item.kind !== 'checkpoint') seen += 1;
      if (seen === position) return this.from(index + 1);
    }
    return { kind: 'end' };
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
