import { describe, expect, it } from 'vitest';
import { sendBackPaths, sendBackSentence } from '../features/workflow-diagram/flow-model';

const kinds = (...list: string[]) => list.map((kind) => ({ kind }));

describe('sendBackPaths', () => {
  it('leads a review back to the work phase before it', () => {
    expect(sendBackPaths(kinds('work', 'review'))).toEqual([{ review: 1, target: 0, lane: 0 }]);
  });

  it('skips checkpoints and goes back to the nearest work phase', () => {
    expect(sendBackPaths(kinds('work', 'checkpoint', 'work', 'checkpoint', 'review'))).toEqual([
      { review: 4, target: 2, lane: 0 },
    ]);
  });

  it('gives each review its own lane, even when two go back to the same phase', () => {
    expect(sendBackPaths(kinds('work', 'review', 'review', 'work', 'review'))).toEqual([
      { review: 1, target: 0, lane: 0 },
      { review: 2, target: 0, lane: 1 },
      { review: 4, target: 3, lane: 2 },
    ]);
  });

  it('has no path for a review with no work phase before it, or for no review', () => {
    expect(sendBackPaths(kinds('review', 'work'))).toEqual([]);
    expect(sendBackPaths(kinds('work', 'checkpoint'))).toEqual([]);
    expect(sendBackPaths([])).toEqual([]);
  });
});

describe('sendBackSentence', () => {
  it.each([
    [2, 'Changes requested go back to build, at most 2 times.'],
    [1, 'Changes requested go back to build, at most 1 time.'],
    [0, 'Changes requested are not sent back: this Workflow allows no send-back.'],
  ])('says it for a limit of %i', (limit, sentence) => {
    expect(sendBackSentence('build', limit)).toBe(sentence);
  });
});
