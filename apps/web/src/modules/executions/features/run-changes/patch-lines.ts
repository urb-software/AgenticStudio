import type { DiffLine } from '@/shared/components/diff-view';

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The rows of one file's unified diff (Git's text for the file, Issue #144) for the DiffView:
 * each hunk header, then its added, deleted and context lines with their old and new line
 * numbers. Git's file headers (`diff --git`, `index`, `---`, `+++`, renames, modes) before the
 * first hunk are left out; a patch without a hunk (a pure rename or mode change) has no rows.
 * The text is kept verbatim, to be shown as plain text.
 */
export function patchLines(patch: string): DiffLine[] {
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const rows: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of lines) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      rows.push({ type: 'hunk', text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('diff --git ')) {
      // Another file's headers (never in a per-file patch): skip to its first hunk.
      inHunk = false;
      continue;
    }
    const sign = line[0];
    const text = line.slice(1);
    if (sign === '+') rows.push({ type: 'add', new: newLine++, text });
    else if (sign === '-') rows.push({ type: 'del', old: oldLine++, text });
    else if (sign === ' ') rows.push({ type: 'ctx', old: oldLine++, new: newLine++, text });
    else rows.push({ type: 'meta', text: line });
  }
  return rows;
}
