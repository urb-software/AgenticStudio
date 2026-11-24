import { describe, expect, it } from 'vitest';
import { PreviewStartLimit, type PreviewStartLimitOccupant } from '../preview-start-limit.js';

const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-000000000002';
const C = 'c0000000-0000-4000-8000-000000000003';
const taking = (...ids: string[]): PreviewStartLimitOccupant[] =>
  ids.map((projectId) => ({ projectId, state: 'running' }));

describe('PreviewStartLimit', () => {
  it('accepts a Project while a place is free', () => {
    expect(PreviewStartLimit.of(3).refusal({ projectId: C, occupying: taking(A, B) })).toBeNull();
    expect(PreviewStartLimit.of(1).refusal({ projectId: A, occupying: [] })).toBeNull();
  });

  it('refuses at the edge, with the Projects that hold the places', () => {
    const occupying = taking(A, B);

    expect(PreviewStartLimit.of(2).refusal({ projectId: C, occupying })).toEqual(occupying);
    expect(PreviewStartLimit.of(1).refusal({ projectId: C, occupying })).toEqual(occupying);
  });

  it('lets a Project that holds a place start again, even at the limit', () => {
    expect(PreviewStartLimit.of(2).refusal({ projectId: A, occupying: taking(A, B) })).toBeNull();
    expect(PreviewStartLimit.of(1).refusal({ projectId: A, occupying: taking(A) })).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses a limit of %s', (max) => {
    expect(() => PreviewStartLimit.of(max)).toThrow(RangeError);
  });
});
