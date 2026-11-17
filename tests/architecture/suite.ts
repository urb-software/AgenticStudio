import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkGate, listDirectories, ruleNames, type Gate } from './harness';

export const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** The fixture table of docs/engineering/quality.md §5, with the gate that proves each row. */
export const QUALITY_TABLE = [
  { row: 'Handler imports a port from its own module', expected: 'PASS', gate: 'api' },
  { row: "Handler imports another module's private repository", expected: 'FAIL', gate: 'api' },
  { row: 'Domain imports ORM/NestJS', expected: 'FAIL', gate: 'api' },
  { row: 'Consumer imports publisher-owned public versioned event', expected: 'PASS', gate: 'api' },
  { row: 'Module publishes an unversioned integration event', expected: 'FAIL', gate: 'api' },
  { row: 'Two modules define the same integration event', expected: 'FAIL', gate: 'api' },
  {
    row: 'Integration event re-exported by another module or under another name',
    expected: 'FAIL',
    gate: 'api',
  },
  {
    row: 'Repository contract declared outside `domain/repositories/`',
    expected: 'FAIL',
    gate: 'api',
  },
  { row: 'Web imports `@/modules/agents` public entrypoint', expected: 'PASS', gate: 'web' },
  { row: "Web deep-imports another module's private Zustand store", expected: 'FAIL', gate: 'web' },
  { row: 'Two modules introduce a dependency cycle', expected: 'FAIL', gate: 'api' },
  {
    row: '`application/` imports an HTTP, schema, OpenAPI, queue or scheduler API',
    expected: 'FAIL',
    gate: 'api',
  },
  {
    row: '`application/` imports only domain, ports and its own files',
    expected: 'PASS',
    gate: 'api',
  },
  { row: '`entry-points/` imports a handler', expected: 'PASS', gate: 'api' },
  {
    row: '`entry-points/` imports a repository interface, port or infrastructure file',
    expected: 'FAIL',
    gate: 'api',
  },
  { row: '`contracts/` holds `index.ts` and `events/` only', expected: 'PASS', gate: 'api' },
  { row: '`contracts/` holds another file', expected: 'FAIL', gate: 'api' },
  { row: '`contracts/` holds another directory', expected: 'FAIL', gate: 'api' },
  { row: 'A production file of a module imports a test file', expected: 'FAIL', gate: 'api' },
  { row: 'A test file imports a test helper', expected: 'PASS', gate: 'api' },
  { row: 'A feature imports another feature of its module', expected: 'FAIL', gate: 'api' },
  { row: 'A feature imports a port, the domain or its own files', expected: 'PASS', gate: 'api' },
  {
    row: 'A test of `application/` imports `platform/queue/` (tests are not checked)',
    expected: 'PASS',
    gate: 'api',
  },
  {
    row: 'A test of a feature imports another feature (tests are not checked)',
    expected: 'PASS',
    gate: 'api',
  },
  {
    row: 'A subdirectory of `entry-points/http/shared/` is named `shared`, `common`, `utils` or `helpers`',
    expected: 'FAIL',
    gate: 'api',
  },
  {
    row: 'A module has `entry-points/http/shared/` (the one exemption)',
    expected: 'PASS',
    gate: 'api',
  },
  {
    row: 'A module has a `shared`, `common`, `utils` or `helpers` directory, e.g. `application/shared/`',
    expected: 'FAIL',
    gate: 'api',
  },
  {
    row: '`domain/entities/` file exports a class with a non-public constructor',
    expected: 'PASS',
    gate: 'api',
  },
  {
    row: '`domain/entities/` file exports a class with a public constructor, or no class',
    expected: 'FAIL',
    gate: 'api',
  },
  {
    row: '`entry-points/` imports a type or an error from `domain/entities/`',
    expected: 'PASS',
    gate: 'api',
  },
  { row: '`entry-points/` imports a class from `domain/entities/`', expected: 'FAIL', gate: 'api' },
  {
    row: 'A handler returns a snapshot, ids, values or a view type, and exports its input and result types',
    expected: 'PASS',
    gate: 'api',
  },
  {
    row: 'A handler returns an entity class, or does not export its result type',
    expected: 'FAIL',
    gate: 'api',
  },
  { row: 'A repository interface refers to one entity file', expected: 'PASS', gate: 'api' },
  {
    row: 'A repository interface refers to two entity files, or its main type is under `domain/value-objects/`',
    expected: 'FAIL',
    gate: 'api',
  },
  {
    row: 'An entity file imports another entity file for an id type',
    expected: 'PASS',
    gate: 'api',
  },
  {
    row: 'An entity file imports another entity file for anything else',
    expected: 'FAIL',
    gate: 'api',
  },
  { row: 'A module has no `domain/services/` directory', expected: 'PASS', gate: 'api' },
  { row: 'A module has a `domain/services/` directory', expected: 'FAIL', gate: 'api' },
  { row: '`domain/` imports only `domain/` and plain libraries', expected: 'PASS', gate: 'api' },
  { row: '`domain/` imports from `application/ports/`', expected: 'FAIL', gate: 'api' },
  {
    row: 'A domain test imports only the domain and test helpers',
    expected: 'PASS',
    gate: 'api',
  },
  {
    row: 'A domain test imports a database client or container tooling',
    expected: 'FAIL',
    gate: 'api',
  },
  {
    row: 'A `domain/entities/` file exports exactly one class and no function',
    expected: 'PASS',
    gate: 'api',
  },
  {
    row: 'A `domain/entities/` file exports a second class or any function',
    expected: 'FAIL',
    gate: 'api',
  },
  {
    row: '`domain/` exports only classes, types, constants and type guards',
    expected: 'PASS',
    gate: 'api',
  },
  { row: '`domain/` exports a function other than a type guard', expected: 'FAIL', gate: 'api' },
] as const;

export interface FixtureCase {
  /** Directory under `fixtures/<gate>/`. */
  fixture: string;
  /** Rules the fixture must break; `[]` means the fixture must PASS. */
  expected: string[];
  /** The `docs/engineering/quality.md` §5 row this fixture proves, if any. */
  qualityRow?: (typeof QUALITY_TABLE)[number]['row'];
}

/**
 * The gate itself: the real tree must have no violations, and every fixture must give
 * exactly its expected result, so a config edit cannot silently disable a rule.
 */
export function describeGate(
  name: string,
  gate: Gate,
  realTree: string,
  cases: FixtureCase[],
): void {
  const fixturesDir = join(import.meta.dirname, 'fixtures', name);

  describe(`architecture:${name}`, () => {
    it(`${realTree} has no violations`, async () => {
      const { violations, filesCruised, npmDependencies } = await checkGate(
        gate,
        join(REPO_ROOT, realTree),
        REPO_ROOT,
      );
      expect(violations).toEqual([]);
      // Guard against a vacuous pass: the cruised directories moved, or npm imports
      // fell out of the graph (fixtures use unresolved package names, the real tree does not).
      expect(filesCruised).toBeGreaterThan(0);
      expect(npmDependencies).toBeGreaterThan(0);
    });

    describe('fixtures', () => {
      it.each(cases)('$fixture → $expected', async ({ fixture, expected }) => {
        const { violations } = await checkGate(gate, join(fixturesDir, fixture));
        const broken = [...new Set(violations.map((violation) => violation.rule))].sort();
        expect(broken, JSON.stringify(violations, null, 2)).toEqual([...expected].sort());
      });

      it('every fixture directory has a case and every case has a directory', () => {
        expect(listDirectories(fixturesDir, '.')).toEqual(cases.map((c) => c.fixture).sort());
      });

      it('every rule is proven by a PASS fixture and at least one FAIL fixture', () => {
        expect(cases.some((c) => c.expected.length === 0)).toBe(true);
        const proven = new Set(cases.flatMap((c) => c.expected));
        expect(ruleNames(gate).filter((rule) => !proven.has(rule))).toEqual([]);
        expect([...proven].filter((rule) => !ruleNames(gate).includes(rule))).toEqual([]);
      });

      it('every quality.md §5 row of this gate has a fixture with the expected outcome', () => {
        for (const { row, expected } of QUALITY_TABLE.filter((r) => r.gate === name)) {
          const outcomes = cases
            .filter((c) => c.qualityRow === row)
            .map((c) => (c.expected.length === 0 ? 'PASS' : 'FAIL'));
          expect(outcomes, row).not.toHaveLength(0);
          expect(
            outcomes.every((outcome) => outcome === expected),
            row,
          ).toBe(true);
        }
      });

      it('every dependency rule is a blocking error', () => {
        expect(gate.forbidden.filter((rule) => rule.severity !== 'error')).toEqual([]);
      });
    });
  });
}
