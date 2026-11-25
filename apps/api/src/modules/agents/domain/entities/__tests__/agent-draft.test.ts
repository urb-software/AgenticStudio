import { describe, expect, it } from 'vitest';
import {
  DraftFileNotFoundError,
  DraftNoBaseError,
  DraftPathConflictError,
  DraftPathNotWritableError,
  DraftPathTakenError,
  DraftTooLargeError,
  DraftTooManyFilesError,
} from '../../errors/agent-draft-errors.js';
import { DraftFileTooLargeError } from '../../value-objects/agent-draft-file-size.js';
import { InvalidAgentDraftPathError } from '../../value-objects/agent-draft-path.js';
import { AgentDraft } from '../agent-draft.js';
import type { AgentDraftBaseEntry } from '../agent-draft-facts.js';

const BASE = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const T0 = new Date('2026-11-25T10:00:00Z');
const T1 = new Date('2026-11-25T11:00:00Z');
const MIB = 1024 * 1024;

const TREE: AgentDraftBaseEntry[] = [
  { path: 'README.md', kind: 'file' },
  { path: 'agents/reviewer/AGENT.md', kind: 'file' },
  { path: 'agents/reviewer/notes.txt', kind: 'file' },
  { path: 'agents/linked', kind: 'symlink' },
  { path: 'vendor/lib', kind: 'submodule' },
];

const facts = (extra: { now?: Date; currentCommit?: string | null } = {}) => ({
  currentCommit: extra.currentCommit === undefined ? BASE : extra.currentCommit,
  baseEntries: TREE,
  now: extra.now ?? T0,
});

const empty = () => AgentDraft.empty(T0);

function paths(draft: AgentDraft): [string, string][] {
  return draft.files.map((file) => [file.path, file.change]);
}

describe('AgentDraft', () => {
  describe('an empty Draft', () => {
    it('has no base, no file and version 0', () => {
      const draft = empty();

      expect(draft.baseCommit).toBeNull();
      expect(draft.version).toBe(0);
      expect(draft.files).toEqual([]);
    });
  });

  describe('put', () => {
    it('takes the current commit as the base with the first change and raises the version', () => {
      const draft = empty();

      draft.put({ ...facts(), path: 'agents/new/AGENT.md', size: 10 });

      expect(draft.baseCommit).toBe(BASE);
      expect(draft.version).toBe(1);
      expect(draft.updatedAt).toEqual(T0);
      expect(draft.files).toHaveLength(1);
      expect(draft.files[0]).toMatchObject({
        path: 'agents/new/AGENT.md',
        change: 'added',
        size: 10,
        movedFrom: null,
      });
    });

    it('keeps the base of the first change when the Repository moves on', () => {
      const draft = empty();
      draft.put({ ...facts(), path: 'a.txt', size: 1 });

      draft.put({ ...facts({ currentCommit: OTHER, now: T1 }), path: 'b.txt', size: 1 });

      expect(draft.baseCommit).toBe(BASE);
      expect(draft.version).toBe(2);
      expect(draft.updatedAt).toEqual(T1);
    });

    it('marks a file the base holds as modified, and one it does not as added', () => {
      const draft = empty();

      draft.put({ ...facts(), path: 'README.md', size: 5 });
      draft.put({ ...facts(), path: 'docs/new.md', size: 5 });

      expect(paths(draft)).toEqual(
        expect.arrayContaining([
          ['README.md', 'modified'],
          ['docs/new.md', 'added'],
        ]),
      );
    });

    it('replaces an earlier write of the same path, with the new size', () => {
      const draft = empty();
      draft.put({ ...facts(), path: 'docs/new.md', size: 5 });

      draft.put({ ...facts({ now: T1 }), path: 'docs/new.md', size: 9 });

      expect(draft.files).toHaveLength(1);
      expect(draft.files[0]).toMatchObject({ change: 'added', size: 9, updatedAt: T1 });
      expect(draft.version).toBe(2);
    });

    it('turns a deleted base file into a modified one when it is written again', () => {
      const draft = empty();
      draft.delete({ ...facts(), path: 'README.md' });

      draft.put({ ...facts(), path: 'README.md', size: 3 });

      expect(paths(draft)).toEqual([['README.md', 'modified']]);
    });

    it('refuses without a commit to base the Draft on, and changes nothing', () => {
      const draft = empty();

      expect(() =>
        draft.put({ ...facts({ currentCommit: null }), path: 'a.txt', size: 1 }),
      ).toThrow(DraftNoBaseError);
      expect(draft.version).toBe(0);
      expect(draft.files).toEqual([]);
    });

    it('refuses a path that is a symbolic link or a submodule at the base', () => {
      const draft = empty();

      expect(() => draft.put({ ...facts(), path: 'agents/linked', size: 1 })).toThrow(
        DraftPathNotWritableError,
      );
      expect(() => draft.put({ ...facts(), path: 'vendor/lib', size: 1 })).toThrow(
        DraftPathNotWritableError,
      );
      expect(draft.files).toEqual([]);
    });

    it.each(['../x', '/abs', 'a\\b', 'agents/.git/config', 'a//b', ''])(
      'refuses the path %j by the shared path rules',
      (path) => {
        expect(() => empty().put({ ...facts(), path, size: 1 })).toThrow(
          InvalidAgentDraftPathError,
        );
      },
    );

    it('refuses a file over 1 MiB with its own reason, and exactly 1 MiB is fine', () => {
      const draft = empty();

      expect(() => draft.put({ ...facts(), path: 'big.bin', size: MIB + 1 })).toThrow(
        DraftFileTooLargeError,
      );
      draft.put({ ...facts(), path: 'big.bin', size: MIB });

      expect(draft.files[0]!.size).toBe(MIB);
    });

    it('refuses a write that takes the whole Draft over 10 MiB, and keeps the earlier state', () => {
      const draft = empty();
      for (let index = 0; index < 10; index += 1) {
        draft.put({ ...facts(), path: `big/${index}.bin`, size: MIB });
      }

      expect(() => draft.put({ ...facts(), path: 'big/over.bin', size: 1 })).toThrow(
        DraftTooLargeError,
      );
      expect(draft.files).toHaveLength(10);
      expect(draft.version).toBe(10);
    });

    it('refuses a write that makes more than 200 changed files, and 200 are fine', () => {
      const draft = empty();
      for (let index = 0; index < 200; index += 1) {
        draft.put({ ...facts(), path: `many/${index}.txt`, size: 1 });
      }

      expect(() => draft.put({ ...facts(), path: 'many/200.txt', size: 1 })).toThrow(
        DraftTooManyFilesError,
      );
      // Writing a file again is no new file.
      draft.put({ ...facts(), path: 'many/0.txt', size: 2 });
      expect(draft.files).toHaveLength(200);
    });

    it('refuses a file where a folder is and a folder where a file is', () => {
      const draft = empty();

      expect(() => draft.put({ ...facts(), path: 'agents/reviewer', size: 1 })).toThrow(
        DraftPathConflictError,
      );
      expect(() => draft.put({ ...facts(), path: 'README.md/inner.txt', size: 1 })).toThrow(
        DraftPathConflictError,
      );
      draft.put({ ...facts(), path: 'docs/a.md', size: 1 });
      expect(() => draft.put({ ...facts(), path: 'docs', size: 1 })).toThrow(
        DraftPathConflictError,
      );
    });

    it('allows a file where a folder was entirely deleted by the Draft', () => {
      const draft = empty();
      draft.delete({ ...facts(), path: 'agents/reviewer/AGENT.md' });
      draft.delete({ ...facts(), path: 'agents/reviewer/notes.txt' });

      draft.put({ ...facts(), path: 'agents/reviewer', size: 1 });

      expect(draft.files.find((file) => file.path === 'agents/reviewer')).toMatchObject({
        change: 'added',
      });
    });
  });

  describe('delete', () => {
    it('marks a base file deleted, with no size, and takes the base', () => {
      const draft = empty();

      draft.delete({ ...facts(), path: 'README.md' });

      expect(draft.baseCommit).toBe(BASE);
      expect(draft.version).toBe(1);
      expect(draft.files[0]).toMatchObject({ path: 'README.md', change: 'deleted', size: 0 });
    });

    it('lets an added file simply disappear, and the Draft is empty again with no base', () => {
      const draft = empty();
      draft.put({ ...facts(), path: 'docs/new.md', size: 5 });

      draft.delete({ ...facts(), path: 'docs/new.md' });

      expect(draft.files).toEqual([]);
      expect(draft.baseCommit).toBeNull();
      expect(draft.version).toBe(2);
    });

    it('deletes a modified file in one step, dropping its content change', () => {
      const draft = empty();
      draft.put({ ...facts(), path: 'README.md', size: 5 });
      draft.put({ ...facts(), path: 'docs/new.md', size: 5 });

      draft.delete({ ...facts(), path: 'README.md' });

      expect(draft.files.find((file) => file.path === 'README.md')).toMatchObject({
        change: 'deleted',
        size: 0,
      });
      expect(draft.version).toBe(3);
    });

    it('refuses to delete a file the Draft already deletes', () => {
      const draft = empty();
      draft.delete({ ...facts(), path: 'README.md' });

      expect(() => draft.delete({ ...facts(), path: 'README.md' })).toThrow(DraftFileNotFoundError);
    });

    it('refuses a path that is nowhere, and a link or a submodule at the base', () => {
      const draft = empty();

      expect(() => draft.delete({ ...facts(), path: 'nothing.txt' })).toThrow(
        DraftFileNotFoundError,
      );
      expect(() => draft.delete({ ...facts(), path: 'agents/linked' })).toThrow(
        DraftPathNotWritableError,
      );
      expect(() => draft.delete({ ...facts(), path: 'vendor/lib' })).toThrow(
        DraftPathNotWritableError,
      );
      expect(draft.version).toBe(0);
    });

    it('refuses to delete a file when the Repository has no commit, and a folder is no file', () => {
      expect(() =>
        empty().delete({ ...facts({ currentCommit: null }), path: 'README.md' }),
      ).toThrow(DraftNoBaseError);
      expect(() => empty().delete({ ...facts(), path: 'agents/reviewer' })).toThrow(
        DraftFileNotFoundError,
      );
    });

    it('refuses the 201st changed file', () => {
      const draft = empty();
      const many = Array.from({ length: 201 }, (_, index) => ({
        path: `many/${index}.txt`,
        kind: 'file' as const,
      }));
      for (let index = 0; index < 200; index += 1) {
        draft.delete({ ...facts(), baseEntries: many, path: `many/${index}.txt` });
      }

      expect(() => draft.delete({ ...facts(), baseEntries: many, path: 'many/200.txt' })).toThrow(
        DraftTooManyFilesError,
      );
    });
  });

  describe('move', () => {
    it('deletes the base file and adds the new path, linked by movedFrom', () => {
      const draft = empty();

      draft.move({ ...facts(), from: 'agents/reviewer/notes.txt', to: 'docs/notes.txt', size: 7 });

      expect(draft.baseCommit).toBe(BASE);
      expect(draft.version).toBe(1);
      expect(paths(draft)).toEqual(
        expect.arrayContaining([
          ['agents/reviewer/notes.txt', 'deleted'],
          ['docs/notes.txt', 'added'],
        ]),
      );
      expect(draft.files.find((file) => file.path === 'docs/notes.txt')).toMatchObject({
        size: 7,
        movedFrom: 'agents/reviewer/notes.txt',
      });
    });

    it('moves a Draft-only file by dropping it, and the new path is added with no link', () => {
      const draft = empty();
      draft.put({ ...facts(), path: 'docs/a.md', size: 4 });

      draft.move({ ...facts(), from: 'docs/a.md', to: 'docs/b.md', size: 4 });

      expect(paths(draft)).toEqual([['docs/b.md', 'added']]);
      expect(draft.files[0]!.movedFrom).toBeNull();
    });

    it('moves a modified base file: the old path is deleted, the new one added', () => {
      const draft = empty();
      draft.put({ ...facts(), path: 'README.md', size: 4 });

      draft.move({ ...facts(), from: 'README.md', to: 'docs/README.md', size: 4 });

      expect(paths(draft)).toEqual(
        expect.arrayContaining([
          ['README.md', 'deleted'],
          ['docs/README.md', 'added'],
        ]),
      );
      expect(draft.files.find((file) => file.path === 'docs/README.md')!.movedFrom).toBe(
        'README.md',
      );
    });

    it('keeps the first origin when a moved file moves again', () => {
      const draft = empty();
      draft.move({ ...facts(), from: 'README.md', to: 'a.md', size: 4 });

      draft.move({ ...facts(), from: 'a.md', to: 'b.md', size: 4 });

      expect(paths(draft)).toEqual(
        expect.arrayContaining([
          ['README.md', 'deleted'],
          ['b.md', 'added'],
        ]),
      );
      expect(draft.files).toHaveLength(2);
      expect(draft.files.find((file) => file.path === 'b.md')!.movedFrom).toBe('README.md');
    });

    it('moves onto a base path the Draft deleted, as a modified file', () => {
      const draft = empty();
      draft.delete({ ...facts(), path: 'agents/reviewer/notes.txt' });

      draft.move({ ...facts(), from: 'README.md', to: 'agents/reviewer/notes.txt', size: 3 });

      expect(paths(draft)).toEqual(
        expect.arrayContaining([
          ['README.md', 'deleted'],
          ['agents/reviewer/notes.txt', 'modified'],
        ]),
      );
    });

    it('refuses a move onto an existing path, in the base or in the Draft', () => {
      const draft = empty();
      draft.put({ ...facts(), path: 'docs/a.md', size: 1 });

      expect(() => draft.move({ ...facts(), from: 'docs/a.md', to: 'README.md', size: 1 })).toThrow(
        DraftPathTakenError,
      );
      draft.put({ ...facts(), path: 'docs/b.md', size: 1 });
      expect(() => draft.move({ ...facts(), from: 'docs/a.md', to: 'docs/b.md', size: 1 })).toThrow(
        DraftPathTakenError,
      );
      expect(() => draft.move({ ...facts(), from: 'docs/a.md', to: 'docs/a.md', size: 1 })).toThrow(
        DraftPathTakenError,
      );
      expect(draft.version).toBe(2);
    });

    it('refuses a source that is nowhere or deleted, and a link or submodule at the base', () => {
      const draft = empty();

      expect(() => draft.move({ ...facts(), from: 'none.md', to: 'x.md', size: 1 })).toThrow(
        DraftFileNotFoundError,
      );
      expect(() => draft.move({ ...facts(), from: 'agents/linked', to: 'x.md', size: 1 })).toThrow(
        DraftPathNotWritableError,
      );
      draft.delete({ ...facts(), path: 'README.md' });
      expect(() => draft.move({ ...facts(), from: 'README.md', to: 'x.md', size: 1 })).toThrow(
        DraftFileNotFoundError,
      );
    });

    it('refuses a target that is a link or submodule at the base, an unsafe or oversize one', () => {
      const draft = empty();

      expect(() =>
        draft.move({ ...facts(), from: 'README.md', to: 'vendor/lib', size: 1 }),
      ).toThrow(DraftPathNotWritableError);
      expect(() => draft.move({ ...facts(), from: 'README.md', to: '../x', size: 1 })).toThrow(
        InvalidAgentDraftPathError,
      );
      expect(() =>
        draft.move({ ...facts(), from: 'README.md', to: 'big.bin', size: MIB + 1 }),
      ).toThrow(DraftFileTooLargeError);
      expect(draft.files).toEqual([]);
    });

    it('refuses a target that would be a file and a folder at once', () => {
      const draft = empty();

      expect(() =>
        draft.move({ ...facts(), from: 'README.md', to: 'agents/reviewer', size: 1 }),
      ).toThrow(DraftPathConflictError);
      expect(() =>
        draft.move({
          ...facts(),
          from: 'agents/reviewer/notes.txt',
          to: 'README.md/inner',
          size: 1,
        }),
      ).toThrow(DraftPathConflictError);
      expect(draft.files).toEqual([]);
    });
  });

  describe('revert', () => {
    it('drops an added file and a modified one, which is as the base has it again', () => {
      const draft = empty();
      draft.put({ ...facts(), path: 'README.md', size: 5 });
      draft.put({ ...facts(), path: 'docs/new.md', size: 5 });

      draft.revert({ path: 'README.md', now: T1 });
      expect(paths(draft)).toEqual([['docs/new.md', 'added']]);
      expect(draft.baseCommit).toBe(BASE);
      draft.revert({ path: 'docs/new.md', now: T1 });

      expect(draft.files).toEqual([]);
      expect(draft.baseCommit).toBeNull();
      expect(draft.version).toBe(4);
      expect(draft.updatedAt).toEqual(T1);
    });

    it('brings back a file the Draft deleted', () => {
      const draft = empty();
      draft.delete({ ...facts(), path: 'README.md' });

      draft.revert({ path: 'README.md', now: T1 });

      expect(draft.files).toEqual([]);
      expect(draft.baseCommit).toBeNull();
    });

    it('removes the new path of a moved file and restores the original', () => {
      const draft = empty();
      draft.move({ ...facts(), from: 'README.md', to: 'docs/README.md', size: 4 });
      draft.put({ ...facts(), path: 'other.md', size: 1 });

      draft.revert({ path: 'docs/README.md', now: T1 });

      expect(paths(draft)).toEqual([['other.md', 'added']]);
    });

    it('restores the base path a move replaced, as the base has it, and the original with it', () => {
      const draft = empty();
      draft.delete({ ...facts(), path: 'agents/reviewer/notes.txt' });
      draft.move({ ...facts(), from: 'README.md', to: 'agents/reviewer/notes.txt', size: 3 });

      draft.revert({ path: 'agents/reviewer/notes.txt', now: T1 });

      expect(draft.files).toEqual([]);
    });

    it('refuses a path the Draft does not change, and a bad path', () => {
      const draft = empty();

      expect(() => draft.revert({ path: 'README.md', now: T1 })).toThrow(DraftFileNotFoundError);
      expect(() => draft.revert({ path: '../x', now: T1 })).toThrow(InvalidAgentDraftPathError);
      expect(draft.version).toBe(0);
    });
  });

  describe('discard', () => {
    it('empties the Draft, drops the base and still raises the version', () => {
      const draft = empty();
      draft.put({ ...facts(), path: 'a.txt', size: 1 });
      draft.delete({ ...facts(), path: 'README.md' });

      draft.discard(T1);

      expect(draft.files).toEqual([]);
      expect(draft.baseCommit).toBeNull();
      expect(draft.version).toBe(3);
      expect(draft.updatedAt).toEqual(T1);
    });
  });

  describe('restore and toData', () => {
    it('round-trips every field', () => {
      const draft = empty();
      draft.move({ ...facts(), from: 'README.md', to: 'docs/README.md', size: 4 });

      const restored = AgentDraft.restore(draft.toData());

      expect(restored.toData()).toEqual(draft.toData());
      expect(restored.baseCommit).toBe(BASE);
      expect(restored.fileAt('docs/README.md')).toMatchObject({ change: 'added' });
      expect(restored.fileAt('nowhere')).toBeNull();
    });

    it('remembers the version it was restored at, while its own version rises', () => {
      const restored = AgentDraft.restore({
        baseCommit: null,
        version: 7,
        updatedAt: T0,
        files: [],
      });

      restored.put({ ...facts(), path: 'a.txt', size: 1 });

      expect(restored.loadedVersion).toBe(7);
      expect(restored.version).toBe(8);
      expect(empty().loadedVersion).toBe(0);
    });

    it('does not let the caller change the Draft through the data it gave', () => {
      const data = {
        baseCommit: BASE,
        version: 1,
        updatedAt: T0,
        files: [
          { path: 'a.txt', change: 'added' as const, size: 1, movedFrom: null, updatedAt: T0 },
        ],
      };
      const restored = AgentDraft.restore(data);

      (data.files as unknown[]).length = 0;

      expect(restored.files).toHaveLength(1);
    });
  });
});
