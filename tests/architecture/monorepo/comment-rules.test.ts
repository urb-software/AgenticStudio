import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkTree, longComments } from '../../../scripts/comment-rules.mjs';
import { measureComments, report } from '../../../scripts/structure-report.mjs';
import { REPO_ROOT } from '../suite';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'comments');

const rules = (fixture: string) => checkTree(join(FIXTURES, fixture)).map((v) => v.rule);

// Rule 14 (quality.md §5): both checks, shown on fixtures and on the repository itself.
describe('comment rules', () => {
  it.each([
    ['clean', []],
    ['number-in-string-passes', []],
    ['long-run-split-by-code-passes', []],
    ['long-with-reason-passes', []],
    ['web-and-generated-excluded', []],
    ['issue-number-fails', ['comment-no-issue-reference']],
    ['issue-number-in-block-fails', ['comment-no-issue-reference']],
    ['issue-link-fails', ['comment-no-issue-reference']],
    ['step-number-fails', ['comment-no-issue-reference']],
    ['long-block-fails', ['comment-max-lines']],
    ['long-run-fails', ['comment-max-lines']],
    ['long-without-reason-fails', ['comment-long-needs-reason']],
    ['marker-without-reason-short-fails', ['comment-long-needs-reason']],
  ])('fixture %s reports %j', (fixture, expected) => {
    expect(rules(fixture)).toEqual(expected);
  });

  it('counts a marker with a reason as one budgeted long comment', () => {
    expect(longComments(join(FIXTURES, 'long-with-reason-passes'))).toHaveLength(1);
  });

  it('reports flagged files in the structure report, with the change against a base', () => {
    const current = {
      'a.ts': { comment: 5, code: 10, ratio: 0.5 },
      'b.ts': { comment: 1, code: 10, ratio: 0.1 },
    };
    const before = {
      'a.ts': { comment: 5, code: 10, ratio: 0.5 },
      'c.ts': { comment: 9, code: 10, ratio: 0.9 },
    };
    const empty = {
      sizes: {},
      domainOverLimit: {},
      repositoryMethods: {},
      handlerMethods: {},
      collaborators: {},
      featureFiles: {},
    };
    const out = report(
      { ...empty, comments: current } as never,
      { ...empty, comments: before } as never,
    );
    expect(out).toContain('Flagged files: 1 of 2 (-1).');
    expect(out).toContain('| `a.ts` | 0.50 | 5 | 10 |');
    expect(out).not.toContain('b.ts');
  });

  it('measures production files only, with the ratio of the comment rules', () => {
    const measured = measureComments(join(FIXTURES, 'clean'));
    expect(Object.keys(measured)).toEqual(['apps/api/src/clean.ts']);
    expect(measured['apps/api/src/clean.ts']?.comment).toBe(7);
  });

  it('finds no violation in the repository', () => {
    expect(checkTree(REPO_ROOT)).toEqual([]);
  });
});
