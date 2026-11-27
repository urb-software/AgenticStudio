import { describe, expect, it } from 'vitest';
import { WorkflowSequence } from '../workflow-sequence.js';

const ITEMS = [
  { kind: 'work' as const },
  { kind: 'checkpoint' as const },
  { kind: 'work' as const },
  { kind: 'review' as const },
];

describe('the order of the Phases of a Workflow', () => {
  it('counts the Phases, a Checkpoint being none', () => {
    expect(WorkflowSequence.of(ITEMS).phaseCount).toBe(3);
  });

  it('puts the Phase after the one that ended next, one by one', () => {
    expect(WorkflowSequence.of(ITEMS).after(0)).toEqual({ kind: 'phase', position: 1 });
    expect(WorkflowSequence.of(ITEMS).after(1)).toEqual({ kind: 'phase', position: 2 });
  });

  it('ends the Workflow after the last Phase', () => {
    expect(WorkflowSequence.of(ITEMS).after(2)).toEqual({ kind: 'end' });
    expect(WorkflowSequence.of([{ kind: 'work' }]).after(0)).toEqual({ kind: 'end' });
  });

  it('decides from the items it is given and nothing else', () => {
    const items = [{ kind: 'work' as const }, { kind: 'work' as const }];
    expect(WorkflowSequence.of(items).after(0)).toEqual(WorkflowSequence.of([...items]).after(0));
  });
});
