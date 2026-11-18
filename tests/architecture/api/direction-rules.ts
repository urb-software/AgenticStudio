import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { listDirectories, listFiles, type Violation } from '../harness';
import { moduleImports, target } from './syntax';

/**
 * Keeps references inside a module's `domain/` one-way. Counts every import form, type-only ones
 * included; tests are not checked.
 */
export const DIRECTION_RULES = [
  'api-domain-leaves-do-not-import-entities',
  'api-domain-has-no-import-cycles',
];

const DOMAIN_FILE = /^src\/modules\/([^/]+)\/domain\/(?!.*(?:__tests__\/|\.test\.tsx?$)).+\.ts$/;
const LEAF_FILE =
  /^src\/modules\/([^/]+)\/domain\/(value-objects|errors)\/(?!.*__tests__\/).+\.ts$/;
const ENTITIES_FILE = /^src\/modules\/([^/]+)\/domain\/entities\//;

export function directionViolations(baseDir: string): Violation[] {
  return listDirectories(baseDir, 'src/modules').flatMap((module) => {
    const files = listFiles(baseDir, `src/modules/${module}/domain`).filter(
      (path) => DOMAIN_FILE.test(path) && !path.endsWith('.d.ts'),
    );
    const edges = new Map<string, string[]>();
    const violations: Violation[] = [];
    for (const path of files) {
      const reached = moduleImports(baseDir, path)
        .map((entry) => target(path, entry.specifier))
        .filter((to): to is string => to !== undefined && to !== path)
        .filter((to) => DOMAIN_FILE.test(to) && existsSync(join(baseDir, to)));
      edges.set(path, [...new Set(reached)]);
      if (LEAF_FILE.test(path)) {
        for (const to of new Set(reached.filter((file) => ENTITIES_FILE.test(file)))) {
          violations.push({ rule: 'api-domain-leaves-do-not-import-entities', from: path, to });
        }
      }
    }
    return [...violations, ...cycleViolations(edges)];
  });
}

/** One violation per import cycle: every strongly connected component of more than one file. */
function cycleViolations(edges: Map<string, string[]>): Violation[] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: Violation[] = [];
  let counter = 0;
  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, index.get(next)!));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1) {
        const sorted = component.sort();
        found.push({
          rule: 'api-domain-has-no-import-cycles',
          from: sorted[0]!,
          to: sorted
            .slice(1)
            .map((path) => posix.relative(posix.dirname(sorted[0]!), path))
            .join(', '),
        });
      }
    }
  };
  for (const node of [...edges.keys()].sort()) if (!index.has(node)) visit(node);
  return found;
}
