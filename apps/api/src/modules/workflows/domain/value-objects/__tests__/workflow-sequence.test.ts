import { describe, expect, it } from 'vitest';
import { WorkflowSequence } from '../workflow-sequence.js';

const ITEMS = [
  { kind: 'work' as const },
  { kind: 'checkpoint' as const },
  { kind: 'work' as const },
  { kind: 'review' as const },
];

const work = { kind: 'work' as const };
const checkpoint = { kind: 'checkpoint' as const };

describe('the order of the Phases of a Workflow', () => {
  it('counts the Phases, a Checkpoint being none', () => {
    expect(WorkflowSequence.of(ITEMS).phaseCount).toBe(3);
  });

  it('puts the Phase after the one that ended next, one by one', () => {
    expect(WorkflowSequence.of([work, work, work]).after(0)).toEqual({
      kind: 'phase',
      position: 1,
    });
    expect(WorkflowSequence.of(ITEMS).after(1)).toEqual({ kind: 'phase', position: 2 });
  });

  it('ends the Workflow after the last Phase', () => {
    expect(WorkflowSequence.of(ITEMS).after(2)).toEqual({ kind: 'end' });
    expect(WorkflowSequence.of([work]).after(0)).toEqual({ kind: 'end' });
  });

  it('decides from the items it is given and nothing else', () => {
    const items = [work, work];
    expect(WorkflowSequence.of(items).after(0)).toEqual(WorkflowSequence.of([...items]).after(0));
  });

  describe('after a review Phase', () => {
    const flow = WorkflowSequence.of([{ kind: 'work' }, { kind: 'review' }, { kind: 'work' }]);

    it('goes on after approved, and ends after the last Phase', () => {
      expect(flow.after(1, 'approved')).toEqual({ kind: 'phase', position: 2 });
      expect(flow.after(2, 'approved')).toEqual({ kind: 'end' });
    });

    it('ends the Workflow on changes requested, whatever follows the review', () => {
      expect(flow.after(1, 'changes_requested')).toEqual({ kind: 'end' });
      expect(
        WorkflowSequence.of([{ kind: 'work' }, { kind: 'review' }]).after(1, 'changes_requested'),
      ).toEqual({
        kind: 'end',
      });
    });

    it('treats done as it always did', () => {
      expect(flow.after(0, 'done')).toEqual({ kind: 'phase', position: 1 });
    });
  });
});

describe('a Checkpoint in the order of a Workflow', () => {
  it('follows the Phase before it, named by its place among the items', () => {
    expect(WorkflowSequence.of(ITEMS).after(0)).toEqual({ kind: 'checkpoint', item: 1 });
  });

  it('is followed by the next Phase, numbered among the Phases only', () => {
    expect(WorkflowSequence.of(ITEMS).afterCheckpoint(1)).toEqual({ kind: 'phase', position: 1 });
  });

  it('is followed by the next Checkpoint when two come in a row', () => {
    const items = [work, checkpoint, checkpoint, work];
    expect(WorkflowSequence.of(items).after(0)).toEqual({ kind: 'checkpoint', item: 1 });
    expect(WorkflowSequence.of(items).afterCheckpoint(1)).toEqual({ kind: 'checkpoint', item: 2 });
    expect(WorkflowSequence.of(items).afterCheckpoint(2)).toEqual({ kind: 'phase', position: 1 });
  });

  it('ends the Workflow when it is the last item', () => {
    const items = [work, checkpoint];
    expect(WorkflowSequence.of(items).after(0)).toEqual({ kind: 'checkpoint', item: 1 });
    expect(WorkflowSequence.of(items).afterCheckpoint(1)).toEqual({ kind: 'end' });
  });

  it('starts the Workflow at a Checkpoint that is the first item', () => {
    expect(WorkflowSequence.of([checkpoint, work]).first()).toEqual({
      kind: 'checkpoint',
      item: 0,
    });
    expect(WorkflowSequence.of([checkpoint, work]).afterCheckpoint(0)).toEqual({
      kind: 'phase',
      position: 0,
    });
    expect(WorkflowSequence.of([work, checkpoint]).first()).toEqual({ kind: 'phase', position: 0 });
  });
});
