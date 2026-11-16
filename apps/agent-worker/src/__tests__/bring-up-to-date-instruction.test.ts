import { describe, expect, it } from 'vitest';
import { bringUpToDateInstruction } from '../agent-definition/bring-up-to-date.js';

// Issue #147: what the agent is told after Studio's worker merged the integration branch.
describe('bringUpToDateInstruction', () => {
  const merged = {
    outcome: 'merged',
    commit: 'a1b2c3d4e5f6'.padEnd(40, '0'),
    baseCommit: 'b'.repeat(40),
  } as const;

  it('says the merge commit exists, and asks for the checks and what the update broke', () => {
    const text = bringUpToDateInstruction({ integrationBranch: 'main', start: merged, note: '' });
    expect(text).toContain('`main` (commit a1b2c3d)');
    expect(text).toContain('nothing conflicted');
    expect(text).toMatch(/checks/);
    expect(text).toMatch(/Do not rebase, reset, rewrite history or push/);
    expect(text).not.toContain("operator's note");
  });

  it('tells the agent that a conflict that is not text is theirs to stage', () => {
    const text = bringUpToDateInstruction({
      integrationBranch: 'main',
      start: { ...merged, outcome: 'conflicts', files: ['logo.png'], moreFiles: 0 },
      note: '',
    });
    expect(text).toMatch(/not text/);
    expect(text).toMatch(/Studio aborts the merge/);
  });

  it('lists the conflicted files and quotes the operator note as theirs', () => {
    const text = bringUpToDateInstruction({
      integrationBranch: 'main',
      start: {
        outcome: 'conflicts',
        commit: merged.commit,
        files: ['src/a.ts', 'we\nird\u0007name.md'],
        moreFiles: 2,
      },
      note: '  Keep our config.  ',
    });
    expect(text).toContain('- src/a.ts\n- we?ird?name.md\n- and 2 more');
    expect(text).toContain("The operator's note:\n\nKeep our config.");
    expect(text).toMatch(/Do not abort the merge/);
  });
});
