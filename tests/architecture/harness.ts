import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { cruise, type ICruiseResult, type IForbiddenRuleType } from 'dependency-cruiser';
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config';

/** One broken architecture rule. `to` is absent for structural (file-layout) rules. */
export interface Violation {
  rule: string;
  from: string;
  to?: string;
}

/**
 * An architecture gate: Dependency Cruiser rules over the import graph, an optional
 * check for cycles between coarse units (business modules, workspace packages) and
 * optional structural assertions over the file tree. All paths are POSIX paths
 * relative to the directory the gate runs against, so the same gate checks the real
 * tree and the fixtures.
 */
export interface Gate {
  /** Directories to cruise; ones that do not exist are skipped. */
  entries: string[];
  /**
   * Source files not to cruise. Anchor it to the cruised directories: Dependency Cruiser
   * also drops matching dependencies, so a loose `node_modules` pattern would remove
   * every npm import from the graph and silently disable the package rules.
   */
  exclude?: string;
  forbidden: IForbiddenRuleType[];
  unitCycles?: { rule: string; unit: RegExp };
  structural?: { rules: string[]; check: (baseDir: string) => Violation[] };
  /**
   * Resolve `@agentic-studio/*` imports to the package's `src/` instead of its built
   * `dist/` exports, so the workspace graph is complete without a build.
   */
  resolveWorkspacePackagesToSource?: boolean;
  /**
   * Extra paths kept in the graph as leaves but not cruised into (node_modules always
   * is), e.g. generated code: imports of it stay visible to the rules.
   */
  doNotFollow?: string;
}

export interface GateResult {
  violations: Violation[];
  /** Number of source files cruised; 0 on a real tree means the gate checked nothing. */
  filesCruised: number;
  /** Number of imports resolved into node_modules; 0 on a real tree means npm rules see nothing. */
  npmDependencies: number;
}

export async function checkGate(gate: Gate, baseDir: string): Promise<GateResult> {
  const { violations, ...counts } = await dependencyViolations(gate, baseDir);
  violations.push(...(gate.structural?.check(baseDir) ?? []));
  violations.sort((a, b) =>
    `${a.rule} ${a.from} ${a.to ?? ''}`.localeCompare(`${b.rule} ${b.from} ${b.to ?? ''}`),
  );
  return { violations, ...counts };
}

/** Every rule name a gate can report; each must be proven by a FAIL fixture. */
export function ruleNames(gate: Gate): string[] {
  return [
    ...gate.forbidden.map((rule) => rule.name ?? '(unnamed rule)'),
    ...(gate.unitCycles ? [gate.unitCycles.rule] : []),
    ...(gate.structural?.rules ?? []),
  ];
}

async function dependencyViolations(gate: Gate, baseDir: string): Promise<GateResult> {
  const entries = gate.entries.filter((entry) => existsSync(join(baseDir, entry)));
  if (entries.length === 0) {
    return { violations: [], filesCruised: 0, npmDependencies: 0 };
  }

  const tsConfigFile = join(baseDir, 'tsconfig.json');
  const hasTsConfig = existsSync(tsConfigFile);
  const { output } = await cruise(
    entries,
    {
      baseDir,
      validate: true,
      ruleSet: { forbidden: gate.forbidden },
      ...(gate.exclude ? { exclude: gate.exclude } : {}),
      doNotFollow: { path: ['node_modules', ...(gate.doNotFollow ? [gate.doNotFollow] : [])] },
      // Type-only imports are dependencies too: a handler must not even reference an adapter type.
      tsPreCompilationDeps: true,
      ...(hasTsConfig ? { tsConfig: { fileName: tsConfigFile } } : {}),
    },
    gate.resolveWorkspacePackagesToSource ? { alias: workspaceSourceAliases(baseDir) } : {},
    hasTsConfig ? { tsConfig: extractTSConfig(tsConfigFile) } : {},
  );
  const result = output as ICruiseResult;

  const violations: Violation[] = result.summary.violations.map((violation) => ({
    rule: violation.rule.name,
    from: violation.from,
    to: violation.to,
  }));
  if (gate.unitCycles) {
    violations.push(...unitCycleViolations(result, gate.unitCycles.rule, gate.unitCycles.unit));
  }
  const inNodeModules = (path: string) => /(^|\/)node_modules\//.test(path);
  const filesCruised = result.modules.filter(
    (module) => !module.coreModule && !module.couldNotResolve && !inNodeModules(module.source),
  ).length;
  const npmDependencies = result.modules
    .flatMap((module) => module.dependencies)
    .filter((dependency) => inNodeModules(dependency.resolved)).length;
  return { violations, filesCruised, npmDependencies };
}

/**
 * File-level cycle rules miss cycles between business modules or packages that go
 * through different files (A/x → B/y and B/z → A/w), so the import graph is also
 * collapsed to units (the first capture group of `unit`) and checked for cycles.
 */
function unitCycleViolations(result: ICruiseResult, rule: string, unit: RegExp): Violation[] {
  const unitOf = (path: string) => unit.exec(path)?.[1];
  const edges = new Map<string, Set<string>>();
  for (const module of result.modules) {
    const from = unitOf(module.source);
    if (!from) continue;
    for (const dependency of module.dependencies) {
      const to = unitOf(dependency.resolved);
      if (!to || to === from) continue;
      edges.set(from, (edges.get(from) ?? new Set()).add(to));
    }
  }

  return stronglyConnectedComponents(edges)
    .filter((component) => component.length > 1)
    .map((component) => ({ rule, from: component.sort().join(' <-> ') }));
}

/** Tarjan's algorithm over a directed graph given as adjacency sets. */
export function stronglyConnectedComponents(edges: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (node: string) => {
    index.set(node, index.size);
    lowLink.set(node, index.get(node)!);
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        lowLink.set(node, Math.min(lowLink.get(node)!, lowLink.get(next)!));
      } else if (onStack.has(next)) {
        lowLink.set(node, Math.min(lowLink.get(node)!, index.get(next)!));
      }
    }
    if (lowLink.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component);
    }
  };

  for (const node of edges.keys()) {
    if (!index.has(node)) visit(node);
  }
  return components;
}

/** ORM and database access. */
export const ORM_PACKAGES = ['@prisma', 'prisma', '@agentic-studio/database'];

/** Concrete clients for queues, caches, databases, Docker, Git and processes. */
export const CONCRETE_CLIENT_PACKAGES = [
  'bullmq',
  'ioredis',
  'redis',
  'pg',
  'dockerode',
  'execa',
  'simple-git',
  'node-pty',
  'ssh2',
];

/** Framework, HTTP and infrastructure packages that domain code must not import. */
export const INFRASTRUCTURE_PACKAGES = [
  ...ORM_PACKAGES,
  ...CONCRETE_CLIENT_PACKAGES,
  '@nestjs',
  'express',
  'reflect-metadata',
];

/** Server-side or privileged packages the web app must never import or depend on. */
export const SERVER_PACKAGES = [
  ...INFRASTRUCTURE_PACKAGES,
  '@agentic-studio/api',
  '@agentic-studio/testing',
];

/**
 * Regex for npm packages, matching both a resolved path (`…/node_modules/@nestjs/core/…`)
 * and an unresolved module name (`@nestjs/core`).
 */
export function npmPackages(...names: string[]): string {
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `(^|/node_modules/)(${escaped.join('|')})(/|$)`;
}

/** Regex for Node.js core modules, with or without the `node:` prefix. */
export function coreModules(...names: string[]): string {
  return `^(node:)?(${names.join('|')})$`;
}

/** POSIX paths (relative to `baseDir`) of all files below `dir`; missing `dir` gives []. */
export function listFiles(baseDir: string, dir: string): string[] {
  const root = join(baseDir, dir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(baseDir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

/** Names of the direct subdirectories of `dir` (relative to `baseDir`). */
export function listDirectories(baseDir: string, dir: string): string[] {
  const root = join(baseDir, dir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export interface WorkspacePackage {
  /** POSIX path relative to the workspace root, e.g. `apps/web`. */
  dir: string;
  name: string;
  dependencies: string[];
}

/** The workspace packages (`apps/*`, `packages/*`, as in pnpm-workspace.yaml) below `baseDir`. */
export function workspacePackages(baseDir: string): WorkspacePackage[] {
  return ['apps', 'packages'].flatMap((group) =>
    listDirectories(baseDir, group)
      .map((name) => `${group}/${name}`)
      .filter((dir) => existsSync(join(baseDir, dir, 'package.json')))
      .map((dir) => {
        const manifest = JSON.parse(readFileSync(join(baseDir, dir, 'package.json'), 'utf8')) as {
          name: string;
        } & Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>>;
        const dependencies = DEPENDENCY_FIELDS.flatMap((field) =>
          Object.keys(manifest[field] ?? {}),
        );
        return { dir, name: manifest.name, dependencies: [...new Set(dependencies)].sort() };
      }),
  );
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

function workspaceSourceAliases(baseDir: string): Record<string, string> {
  return Object.fromEntries(
    workspacePackages(baseDir).map((pkg) => [pkg.name, join(baseDir, pkg.dir, 'src')]),
  );
}
