import { describe, expect, it } from 'vitest';
import { patchLines } from '../features/run-changes/patch-lines';

// Git's unified diff of one file into DiffView rows.

describe('patchLines', () => {
  it('numbers the old and new lines of each hunk and leaves the file headers out', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      'index 1111111..2222222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
      '@@ -20 +20,2 @@ function f() {',
      ' x',
      '+y',
      '\\ No newline at end of file',
      '',
    ].join('\n');

    expect(patchLines(patch)).toEqual([
      { type: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { type: 'ctx', old: 1, new: 1, text: 'keep' },
      { type: 'del', old: 2, text: 'old' },
      { type: 'add', new: 2, text: 'new' },
      { type: 'hunk', text: '@@ -20 +20,2 @@ function f() {' },
      { type: 'ctx', old: 20, new: 20, text: 'x' },
      { type: 'add', new: 21, text: 'y' },
      { type: 'meta', text: '\\ No newline at end of file' },
    ]);
  });

  it('has no rows for a patch without a hunk (a pure rename)', () => {
    expect(
      patchLines('diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n'),
    ).toEqual([]);
  });

  it('keeps the text verbatim, markup included', () => {
    expect(patchLines('@@ -0,0 +1 @@\n+<script>alert(1)</script>\n').at(-1)).toEqual({
      type: 'add',
      new: 1,
      text: '<script>alert(1)</script>',
    });
  });
});
