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

    it('ends the Workflow on changes requested when no send-back is left', () => {
      expect(flow.after(1, 'changes_requested', { used: 2 })).toEqual({ kind: 'end' });
      expect(
        WorkflowSequence.of([{ kind: 'work' }, { kind: 'review' }], 0).after(
          1,
          'changes_requested',
        ),
      ).toEqual({ kind: 'end' });
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

describe('sending work back after a review', () => {
  const simple = [work, { kind: 'review' as const }];

  it('goes back to the nearest work Phase before the review while the count is below the limit', () => {
    const flow = WorkflowSequence.of(simple);
    expect(flow.after(1, 'changes_requested')).toEqual({ kind: 'send_back', position: 0 });
    expect(flow.after(1, 'changes_requested', { used: 1 })).toEqual({
      kind: 'send_back',
      position: 0,
    });
    expect(flow.after(1, 'changes_requested', { used: 2 })).toEqual({ kind: 'end' });
  });

  it('allows none, one or two send-backs as the recorded limit says', () => {
    const at = (limit: number | undefined, used: number) =>
      WorkflowSequence.of(simple, limit).after(1, 'changes_requested', { used }).kind;
    expect([at(0, 0), at(1, 0), at(1, 1), at(2, 1), at(2, 2)]).toEqual([
      'end',
      'send_back',
      'end',
      'send_back',
      'end',
    ]);
    expect(at(undefined, 1)).toBe('send_back');
    expect(at(undefined, 2)).toBe('end');
  });

  it('never allows more than two, whatever the recorded number says', () => {
    for (const limit of [3, 99, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      expect(WorkflowSequence.of(simple, limit).sendBackLimit).toBe(2);
      expect(WorkflowSequence.of(simple, limit).after(1, 'changes_requested', { used: 2 })).toEqual(
        { kind: 'end' },
      );
    }
    for (const limit of [-1, Number.NaN, 1.5]) {
      expect(WorkflowSequence.of(simple, limit).sendBackLimit).toBeLessThanOrEqual(2);
    }
    expect(WorkflowSequence.of(simple, -1).sendBackLimit).toBe(0);
  });

  it('takes the nearest work Phase, skipping Checkpoints and other reviews between', () => {
    const items = [work, work, checkpoint, { kind: 'review' as const }];
    expect(WorkflowSequence.of(items).after(2, 'changes_requested')).toEqual({
      kind: 'send_back',
      position: 1,
    });
    const reviews = [work, { kind: 'review' as const }, { kind: 'review' as const }];
    expect(WorkflowSequence.of(reviews).after(2, 'changes_requested')).toEqual({
      kind: 'send_back',
      position: 0,
    });
  });

  it('ends the Workflow when no work Phase comes before the review', () => {
    const items = [{ kind: 'review' as const }, work];
    expect(WorkflowSequence.of(items).after(0, 'changes_requested')).toEqual({ kind: 'end' });
  });

  it('shares one count between two review Phases', () => {
    const items = [work, { kind: 'review' as const }, work, { kind: 'review' as const }];
    const flow = WorkflowSequence.of(items);
    expect(flow.after(1, 'changes_requested', { used: 0 })).toEqual({
      kind: 'send_back',
      position: 0,
    });
    // The first review used one: the second has one left, and sends back to its own work Phase.
    expect(flow.after(3, 'changes_requested', { used: 1 })).toEqual({
      kind: 'send_back',
      position: 2,
    });
    expect(flow.after(3, 'changes_requested', { used: 2 })).toEqual({ kind: 'end' });
    expect(flow.after(1, 'changes_requested', { used: 2 })).toEqual({ kind: 'end' });
  });

  it('is unchanged for approved, whatever the count', () => {
    const flow = WorkflowSequence.of([work, { kind: 'review' as const }, work]);
    expect(flow.after(1, 'approved', { used: 2 })).toEqual({ kind: 'phase', position: 2 });
    expect(flow.after(1, 'approved', { used: 0 })).toEqual({ kind: 'phase', position: 2 });
  });

  it('returns from the work Phase straight to the review that sent it back', () => {
    const items = [work, checkpoint, { kind: 'review' as const }, work];
    const flow = WorkflowSequence.of(items);
    expect(flow.after(0, 'done')).toEqual({ kind: 'checkpoint', item: 1 });
    expect(flow.after(0, 'done', { used: 1, returnTo: 1 })).toEqual({ kind: 'phase', position: 1 });
  });

  it('ignores a return for any Phase but the work Phase before the review', () => {
    const flow = WorkflowSequence.of([work, { kind: 'review' as const }, work]);
    expect(flow.after(2, 'done', { used: 1, returnTo: 1 })).toEqual({ kind: 'end' });
    expect(flow.after(0, 'done', { used: 1, returnTo: 0 })).toEqual({ kind: 'phase', position: 1 });
  });
});
