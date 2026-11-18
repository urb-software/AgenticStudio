import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../suite';

/** The report is not a check, but it must measure what it says and never fail. */
const SCRIPT = join(REPO_ROOT, 'scripts', 'structure-report.mjs');

interface Measured {
  sizes: Record<string, number>;
  domainOverLimit: Record<string, number>;
  repositoryMethods: Record<string, number>;
  handlerMethods: Record<string, number>;
  collaborators: Record<string, number>;
  featureFiles: Record<string, number>;
}
interface ReportModule {
  measure: (apiDir: string) => Measured;
  report: (current: Measured, base: Measured | undefined, top?: number) => string;
}

// A variable specifier: the script is plain JavaScript without type declarations.
const load = async (): Promise<ReportModule> =>
  (await import(pathToFileURL(SCRIPT).href)) as ReportModule;

function tree(files: Record<string, string>): string {
  const apiDir = mkdtempSync(join(tmpdir(), 'structure-report-test-'));
  for (const [path, content] of Object.entries(files)) {
    const file = join(apiDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return apiDir;
}

const FILES = {
  'src/modules/notes/application/features/add-note/handler.ts': [
    'export class AddNoteHandler {',
    '  execute(): void {}',
    '  private helper(): void {}',
    '  protected other(): void {}',
    '  also(): void {}',
    '}',
    '',
  ].join('\n'),
  'src/modules/notes/application/features/add-note/__tests__/handler.test.ts': 'export {};\n',
  'src/modules/notes/application/features/add-note/input.ts': 'export {};\n',
  'src/modules/notes/application/note-numbering.ts': 'export class NoteNumbering {}\n',
  'src/modules/notes/domain/entities/note.ts': `${'// line\n'.repeat(401)}export class Note {}\n`,
  'src/modules/notes/domain/entities/tag.ts': '// line\n'.repeat(400),
  'src/modules/notes/domain/repositories/tag-repository.ts': [
    'type TagRepository = { add(tag: string): Promise<void>; find: () => Promise<string[]> };',
    'export { TagRepository };',
    '',
  ].join('\n'),
  'src/modules/notes/domain/repositories/note-repository.ts': [
    'export interface NoteRepository {',
    '  add(note: string): Promise<void>;',
    '  find(id: string): Promise<string | null>;',
    '  find(id: string, deep: boolean): Promise<string | null>;',
    '  count: () => Promise<number>;',
    '}',
    '',
  ].join('\n'),
};

describe('scripts/structure-report.mjs', () => {
  it('measures file sizes, repository methods, handler methods, collaborators and feature files', async () => {
    const { measure } = await load();
    const apiDir = tree(FILES);
    try {
      const measured = measure(apiDir);
      expect(measured.repositoryMethods['notes/NoteRepository']).toBe(3);
      // A type literal alias exported later is a repository interface too.
      expect(measured.repositoryMethods['notes/TagRepository']).toBe(2);
      expect(measured.handlerMethods['notes/application/features/add-note']).toBe(2);
      expect(measured.collaborators).toEqual({ notes: 1 });
      // Rule 13: a file under `domain/` over 400 lines is flagged; one of exactly 400 is not.
      expect(measured.domainOverLimit).toEqual({
        'src/modules/notes/domain/entities/note.ts': 402,
      });
      expect(measured.featureFiles).toEqual({ 'notes/add-note': 3 });
      expect(measured.sizes['src/modules/notes/application/features/add-note/handler.ts']).toBe(6);
      expect(
        measured.sizes['src/modules/notes/application/features/add-note/__tests__/handler.test.ts'],
      ).toBeUndefined();
    } finally {
      rmSync(apiDir, { recursive: true, force: true });
    }
  });

  it('shows the change against a base, and "new" for what the base lacks', async () => {
    const { report } = await load();
    const now: Measured = {
      sizes: { 'src/a.ts': 120, 'src/b.ts': 10, 'src/modules/notes/domain/entities/note.ts': 450 },
      domainOverLimit: { 'src/modules/notes/domain/entities/note.ts': 450 },
      repositoryMethods: { 'notes/NoteRepository': 5 },
      handlerMethods: {},
      collaborators: { notes: 0 },
      featureFiles: {},
    };
    const base: Measured = {
      ...now,
      sizes: { 'src/a.ts': 100, 'src/modules/notes/domain/entities/note.ts': 410 },
      domainOverLimit: {},
    };
    const text = report(now, base);
    expect(text).toMatch(/`src\/a\.ts` \| 120 \(\+20\)/);
    expect(text).toMatch(/`src\/b\.ts` \| 10 \(new\)/);
    expect(text).toMatch(/`notes\/NoteRepository` \| 5 \|/);
    expect(text).toMatch(/domain\/entities\/note\.ts` \| 450 \(\+40\)/);
    expect(report(now, undefined)).not.toMatch(/\(new\)|\(\+/);
  });

  it('exits 0 and still prints a report when the base cannot be read or the tree is missing', () => {
    const output = execFileSync(
      process.execPath,
      [
        SCRIPT,
        '--source',
        join(tmpdir(), 'structure-report-does-not-exist'),
        '--base-ref',
        'no-such-ref',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    expect(output).toMatch(/## API structure report/);
  });

  it('reports the real API', async () => {
    const { measure } = await load();
    const measured = measure(join(REPO_ROOT, 'apps', 'api'));
    expect(Object.keys(measured.repositoryMethods).length).toBeGreaterThan(0);
    expect(Object.keys(measured.handlerMethods).length).toBeGreaterThan(0);
    expect(Object.keys(measured.sizes).length).toBeGreaterThan(0);
  });
});
