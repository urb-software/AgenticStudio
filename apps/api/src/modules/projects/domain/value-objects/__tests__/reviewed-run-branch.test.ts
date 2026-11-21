import { describe, expect, it } from 'vitest';
import { InvalidReviewedRunBranchError, ReviewedRunBranch } from '../reviewed-run-branch.js';

const RUN = '0B8E5C2D-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

describe('ReviewedRunBranch', () => {
  it('accepts the Run’s own agent branch and names its review ref by the Run id', () => {
    const branch = ReviewedRunBranch.of(RUN, 'agent/add-pagination-r0b8e5c2d');

    expect(branch.name).toBe('agent/add-pagination-r0b8e5c2d');
    expect(branch.reviewRef).toBe('refs/studio/review/0b8e5c2d-4d5a-4b6c-9d7e-8f9a0b1c2d3e');
  });

  it.each([
    'agent/add-pagination-rdeadbeef',
    'dev',
    'feature/add-pagination-r0b8e5c2d',
    'agent/r0b8e5c2d',
    'agent/Add-Pagination-r0b8e5c2d',
    'agent/add-pagination-r0b8e5c2d/extra',
    'agent/add-pagination-r0b8e5c2d.lock',
    'agent/../dev-r0b8e5c2d',
  ])('refuses %s', (name) => {
    expect(() => ReviewedRunBranch.of(RUN, name)).toThrow(InvalidReviewedRunBranchError);
  });

  it('refuses a Run id that is not a UUID', () => {
    expect(() => ReviewedRunBranch.of('0b8e5c2d', 'agent/x-r0b8e5c2d')).toThrow(
      InvalidReviewedRunBranchError,
    );
  });
});
