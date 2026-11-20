import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkRepository,
  conflictMarkers,
  DESIGN_SYSTEM_COPY,
  DESIGN_SYSTEM_SOURCE,
} from '../../../scripts/check-repo-guards.mjs';
import { REPO_ROOT } from '../suite';

const roots: string[] = [];

function tree(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'repo-guards-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const CSS = ':root { --a: 1; }\n';
const synced = { [DESIGN_SYSTEM_COPY]: CSS, [DESIGN_SYSTEM_SOURCE]: CSS };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Repository guards (scripts/check-repo-guards.mjs), shown on fixtures and on the repository itself.
describe('design-system copy', () => {
  it('passes when the copy is byte-identical to the source', () => {
    expect(checkRepository(tree(synced), [])).toEqual([]);
  });

  it('fails naming both files and the restore command when they differ', () => {
    const root = tree({ ...synced, [DESIGN_SYSTEM_COPY]: `${CSS} ` });
    const [message] = checkRepository(root, []);
    expect(message).toContain(DESIGN_SYSTEM_COPY);
    expect(message).toContain(DESIGN_SYSTEM_SOURCE);
    expect(message).toContain(`cp ${DESIGN_SYSTEM_SOURCE} ${DESIGN_SYSTEM_COPY}`);
  });

  it('fails when one of the two files is missing', () => {
    const root = tree({ [DESIGN_SYSTEM_SOURCE]: CSS });
    expect(checkRepository(root, [])).toHaveLength(1);
  });
});

describe('conflict markers', () => {
  const markers = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n';

  it('passes a file without markers, including a seven-character heading underline', () => {
    const file = 'Title\n=======\n\ntext\n';
    expect(conflictMarkers('a.md', Buffer.from(file))).toEqual([]);
  });

  it('reports file:line for each marker and for the separator in the same file', () => {
    expect(conflictMarkers('a.txt', Buffer.from(markers))).toEqual([
      'a.txt:1',
      'a.txt:3',
      'a.txt:5',
    ]);
  });

  it('reports a marker without trailing text and ignores indented or longer runs', () => {
    expect(conflictMarkers('a.txt', Buffer.from('<<<<<<<\n  <<<<<<< x\n<<<<<<<<< x\n'))).toEqual([
      'a.txt:1',
    ]);
  });

  it('skips a binary file', () => {
    expect(
      conflictMarkers('a.bin', Buffer.concat([Buffer.from([0]), Buffer.from(markers)])),
    ).toEqual([]);
  });

  it('fails a tracked file with markers and passes without', () => {
    const root = tree({ ...synced, 'good.md': 'Title\n=======\n', 'bad.ts': markers });
    expect(checkRepository(root, ['good.md', 'bad.ts'])).toEqual([
      'bad.ts:1: merge conflict marker',
      'bad.ts:3: merge conflict marker',
      'bad.ts:5: merge conflict marker',
    ]);
  });
});

describe('the repository', () => {
  it('passes its own guards', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    expect(checkRepository(REPO_ROOT, files)).toEqual([]);
  });
});
