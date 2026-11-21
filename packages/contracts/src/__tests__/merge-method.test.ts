import { describe, expect, it } from 'vitest';
import { mergeApprovalSchema, mergeMethodSchema, setMergeMethodRequestSchema } from '../index.js';

describe('merge method contract', () => {
  it('is squash or merge commit; rebase is not a value', () => {
    expect(mergeMethodSchema.options).toEqual(['squash', 'merge_commit']);
    expect(mergeMethodSchema.safeParse('rebase').success).toBe(false);
  });

  it('is what the setting request and the Merge approval use', () => {
    expect(setMergeMethodRequestSchema.safeParse({ mergeMethod: 'merge_commit' }).success).toBe(
      true,
    );
    expect(setMergeMethodRequestSchema.safeParse({}).success).toBe(false);
    expect(setMergeMethodRequestSchema.safeParse({ mergeMethod: 'squash', x: 1 }).success).toBe(
      false,
    );
    expect(mergeApprovalSchema.shape.method).toBe(mergeMethodSchema);
  });
});
