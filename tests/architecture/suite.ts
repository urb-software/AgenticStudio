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
  { row: 'Web imports `@/modules/agents` public entrypoint', expected: 'PASS', gate: 'web' },
  { row: "Web deep-imports another module's private Zustand store", expected: 'FAIL', gate: 'web' },
  { row: 'Two modules introduce a dependency cycle', expected: 'FAIL', gate: 'api' },
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
