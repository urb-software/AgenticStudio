import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listDirectories } from '../harness';
import { QUALITY_TABLE, REPO_ROOT } from '../suite';
import {
  aggregateRoots,
  PINNED_DIRECTORY,
  pinnedListProblems,
  repositoryInterfaces,
} from './pinned-lists';

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');
const pinnedFixtures = join(fixturesDir, 'pinned');
const apiDir = join(REPO_ROOT, 'apps', 'api');

const MATCH = 'Repository methods and application collaborators match the pinned lists';
const DRIFT =
  'A repository method or application collaborator is added, renamed or removed without updating its pinned list';
const ROOTS_MATCH = 'The aggregate roots match the pinned record';
const ROOTS_DRIFT = 'An aggregate root is added or removed without updating its pinned record';

/**
 * One case per fixture under `fixtures/pinned/`. `expected` holds one fragment per problem the
 * fixture must give, so a fixture proves exactly one thing; `[]` means the records match the
 * source.
 */
const CASES: {
  fixture: string;
  expected: string[];
  qualityRow: (typeof QUALITY_TABLE)[number]['row'];
}[] = [
  { fixture: 'lists-match', expected: [], qualityRow: MATCH },
  {
    fixture: 'method-added',
    expected: ['notes/NoteRepository gained the method "archive"'],
    qualityRow: DRIFT,
  },
  {
    fixture: 'method-removed',
    expected: ['notes/NoteRepository no longer has the method "findById"'],
    qualityRow: DRIFT,
  },
  {
    fixture: 'method-renamed',
    expected: [
      'notes/NoteRepository gained the method "findOne"',
      'notes/NoteRepository no longer has the method "findById"',
    ],
    qualityRow: DRIFT,
  },
  {
    fixture: 'repository-interface-added',
    expected: ['Repository interface notes/TagRepository is not recorded'],
    qualityRow: DRIFT,
  },
  {
    fixture: 'atomic-without-reason',
    expected: ['notes/NoteRepository.deleteOlderThan is set-wide and has no "reason"'],
    qualityRow: DRIFT,
  },
  {
    fixture: 'unknown-kind',
    expected: ['notes/NoteRepository.add has the kind "bulk"'],
    qualityRow: DRIFT,
  },
  {
    fixture: 'collaborator-added',
    expected: ['notes/application/note-numbering.ts is a file directly in application/'],
    qualityRow: DRIFT,
  },
  {
    fixture: 'collaborator-removed',
    expected: ['notes/application/note-numbering.ts is recorded as an application collaborator'],
    qualityRow: DRIFT,
  },
  {
    fixture: 'collaborator-without-reason',
    expected: ['notes/application/note-numbering.ts has no "reason"'],
    qualityRow: DRIFT,
  },
  { fixture: 'roots-match', expected: [], qualityRow: ROOTS_MATCH },
  {
    fixture: 'root-added',
    expected: ['notes/Tag (src/modules/notes/domain/entities/tag.ts) is an entity file'],
    qualityRow: ROOTS_DRIFT,
  },
  {
    fixture: 'root-removed',
    expected: ['notes/Tag is recorded as an aggregate root but no such entity class exists'],
    qualityRow: ROOTS_DRIFT,
  },
  {
    fixture: 'root-without-reason',
    expected: ['notes/Note has no "reason"'],
    qualityRow: ROOTS_DRIFT,
  },
];

describe('architecture:api pinned lists', () => {
  it('the records match apps/api (a failure says which file to update and why)', () => {
    expect(pinnedListProblems(apiDir, join(REPO_ROOT, PINNED_DIRECTORY))).toEqual([]);
  });

  it('the records are not vacuous: the API has repository interfaces and aggregate roots', () => {
    expect(Object.keys(repositoryInterfaces(apiDir)).length).toBeGreaterThan(0);
    expect(Object.keys(aggregateRoots(apiDir)).length).toBeGreaterThan(0);
  });

  describe('fixtures', () => {
    it.each(CASES)('$fixture', ({ fixture, expected }) => {
      const base = join(pinnedFixtures, fixture);
      const problems = pinnedListProblems(base, join(base, 'pinned'));
      expect(problems, JSON.stringify(problems, null, 2)).toHaveLength(expected.length);
      for (const fragment of expected) {
        expect(
          problems.some((problem) => problem.includes(fragment)),
          `${fragment}\n${JSON.stringify(problems, null, 2)}`,
        ).toBe(true);
      }
    });

    it('the reference module has its own pinned records, which match its source', () => {
      const base = join(fixturesDir, 'api', 'reference-module');
      expect(pinnedListProblems(base, join(base, 'pinned'))).toEqual([]);
      expect(Object.keys(aggregateRoots(base))).toEqual(['catalog/Product']);
    });

    it('every failing message names the record to update', () => {
      for (const { fixture } of CASES.filter((c) => c.expected.length > 0)) {
        const base = join(pinnedFixtures, fixture);
        for (const problem of pinnedListProblems(base, join(base, 'pinned'))) {
          expect(problem, fixture).toMatch(
            new RegExp(
              `${PINNED_DIRECTORY}/(repository-methods|application-collaborators|aggregate-roots)\\.json`,
            ),
          );
        }
      }
    });

    it('every fixture directory has a case and every case has a directory', () => {
      expect(listDirectories(pinnedFixtures, '.')).toEqual(CASES.map((c) => c.fixture).sort());
    });

    it('every quality.md §5 row of the pinned lists has a fixture with the expected outcome', () => {
      for (const { row, expected } of QUALITY_TABLE.filter((r) => r.gate === 'pinned')) {
        const outcomes = CASES.filter((c) => c.qualityRow === row).map((c) =>
          c.expected.length === 0 ? 'PASS' : 'FAIL',
        );
        expect(outcomes, row).not.toHaveLength(0);
        expect(
          outcomes.every((outcome) => outcome === expected),
          row,
        ).toBe(true);
      }
    });
  });
});
