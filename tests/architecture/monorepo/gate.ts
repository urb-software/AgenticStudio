import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { exportedNames } from '../api/syntax';
import {
  coreModules,
  listFiles,
  npmPackages,
  ORM_PACKAGES,
  SERVER_PACKAGES,
  stronglyConnectedComponents,
  workspacePackages,
  type Gate,
  type Violation,
} from '../harness';

/**
 * Every packages/* package is listed as allowed or forbidden for apps/web (a meta-test enforces
 * it), so a new server-only package cannot reach the web app by default; forbidden ones are also
 * in SERVER_PACKAGES.
 */
export const WEB_PACKAGE_CLASSIFICATION: { allowed: string[]; forbidden: string[] } = {
  allowed: [],
  forbidden: [
    '@agentic-studio/compose-validation',
    '@agentic-studio/contracts',
    '@agentic-studio/database',
    '@agentic-studio/log-redaction',
    '@agentic-studio/testing',
  ],
};

/**
 * The agent worker's production files allowed to import `node:child_process`: the spawn boundary,
 * which checks the provider gate before it creates a process, and the helper-process runner.
 * Adding a file here is a reviewed architecture change.
 */
export const AGENT_WORKER_PROCESS_FILES = [
  'apps/agent-worker/src/spawn-boundary.ts',
  // Runs the worker's own helper processes (`git`, `docker`), never a provider CLI.
  'apps/agent-worker/src/process-runner.ts',
];

/** The agent worker's production code: its src/ outside tests. */
const AGENT_WORKER_PRODUCTION = { path: '^apps/agent-worker/src/', pathNot: '(^|/)__tests__/' };

/**
 * What the agent worker's production code may import besides Node core modules: its own files,
 * the worker protocol and zod. Everything else is denied by default.
 */
export const AGENT_WORKER_ALLOWED_IMPORTS = [
  '^apps/agent-worker/src/',
  '^packages/contracts/',
  npmPackages('zod'),
];

/**
 * The environment controller's production files allowed to import `node:child_process`: the
 * process runner, the one place a process is started. Adding a file here is a reviewed change.
 */
export const CONTROLLER_PROCESS_FILES = ['apps/environment-controller/src/process-runner.ts'];

/** The environment controller's production code: its src/ outside tests. */
const CONTROLLER_PRODUCTION = {
  path: '^apps/environment-controller/src/',
  pathNot: '(^|/)__tests__/',
};

/**
 * What the controller's production code may import besides Node core modules: its own files,
 * the controller protocol, the Compose validation, zod and yaml. Everything else is denied.
 */
export const CONTROLLER_ALLOWED_IMPORTS = [
  '^apps/environment-controller/src/',
  '^packages/contracts/',
  '^packages/compose-validation/',
  npmPackages('zod', 'yaml'),
];

export const monorepoGate: Gate = {
  entries: ['apps', 'packages'],
  exclude: '^(apps|packages)/[^/]+/(node_modules|dist|\\.next|out|coverage)/',
  // Kept as graph leaves, so imports of the generated Prisma client are still checked.
  doNotFollow: '^packages/database/src/generated/',
  resolveWorkspacePackagesToSource: true,
  forbidden: [
    {
      name: 'mono-no-cross-app-imports',
      comment:
        'No hidden app-to-app implementation imports (api, web, agent-worker, ' +
        'environment-controller); apps talk through published contracts and processes.',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'mono-packages-no-apps',
      comment: 'Workspace packages never import app implementations.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'mono-no-relative-imports-into-packages',
      comment:
        'Code outside a package uses it only through its published @agentic-studio/* name, never ' +
        'a relative path that bypasses its exports.',
      severity: 'error',
      from: { path: '^(apps|packages)/([^/]+)/' },
      // A name import resolved through the source alias is both "local" and "aliased".
      to: {
        path: '^packages/',
        pathNot: '^$1/$2/',
        dependencyTypes: ['local'],
        dependencyTypesNot: ['aliased'],
      },
    },
    {
      name: 'mono-web-no-server-implementations',
      comment: 'The web app never imports server or privileged implementations.',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: {
        path: [
          '^packages/(compose-validation|contracts|database|log-redaction|testing)/',
          npmPackages(...SERVER_PACKAGES),
        ],
      },
    },
    {
      name: 'mono-agent-worker-no-studio-infrastructure',
      comment:
        "The agent worker is on the agents' side of the boundary (ADR 0002): outside " +
        'its tests it never imports the database package, the ORM, Redis, the queue, Docker or ' +
        'NestJS, nor the test helpers; it reaches Studio over the worker routes only.',
      severity: 'error',
      from: { path: '^apps/agent-worker/', pathNot: '(^|/)__tests__/' },
      to: {
        path: [
          '^packages/(database|testing)/',
          npmPackages(
            ...ORM_PACKAGES,
            '@agentic-studio/testing',
            'bullmq',
            'bull',
            'ioredis',
            'redis',
            'pg',
            'postgres',
            'dockerode',
            '@nestjs',
          ),
        ],
      },
    },
    {
      name: 'mono-agent-worker-production-no-test-code',
      comment:
        "The agent worker's production code never imports its test code: tests may use the " +
        'database and test helpers, so importing a test file would bridge the rule above.',
      severity: 'error',
      from: { path: '^apps/agent-worker/', pathNot: '(^|/)__tests__/' },
      to: { path: '^apps/agent-worker/.*__tests__/' },
    },
    {
      name: 'mono-agent-worker-spawn-boundary-only',
      comment:
        "Provider CLIs start only through the agent worker's spawn boundary, which checks the " +
        'provider switch (security.md §2): no other production file imports ' +
        'node:child_process.',
      severity: 'error',
      from: {
        path: AGENT_WORKER_PRODUCTION.path,
        pathNot: [
          AGENT_WORKER_PRODUCTION.pathNot,
          ...AGENT_WORKER_PROCESS_FILES.map((file) => `^${file}$`),
        ],
      },
      to: { path: coreModules('child_process') },
    },
    {
      name: 'mono-agent-worker-allowed-imports-only',
      comment:
        "Deny by default: the agent worker's production code imports only its " +
        'own files, @agentic-studio/contracts, zod and Node core modules, so no npm or workspace ' +
        'package (a process wrapper, a package that spawns) can reach past the spawn boundary.',
      severity: 'error',
      from: AGENT_WORKER_PRODUCTION,
      to: { pathNot: AGENT_WORKER_ALLOWED_IMPORTS, dependencyTypesNot: ['core'] },
    },
    {
      name: 'mono-agent-worker-no-loader-core-modules',
      comment:
        "The agent worker's production code never imports node:module (createRequire would load " +
        'child_process unseen), node:vm (code the graph cannot see), node:cluster or ' +
        'node:worker_threads.',
      severity: 'error',
      from: AGENT_WORKER_PRODUCTION,
      to: { path: coreModules('module', 'vm', 'cluster', 'worker_threads') },
    },
    {
      name: 'mono-controller-no-studio-infrastructure',
      comment:
        'The environment controller runs as the Preview user with its own token: outside its ' +
        'tests it never imports the database package, the ORM, Redis, the queue, NestJS or the ' +
        'test helpers; it reaches Studio over the controller routes only.',
      severity: 'error',
      from: { path: '^apps/environment-controller/', pathNot: '(^|/)__tests__/' },
      to: {
        path: [
          '^packages/(database|testing|log-redaction)/',
          npmPackages(
            ...ORM_PACKAGES,
            '@agentic-studio/testing',
            '@agentic-studio/log-redaction',
            'bullmq',
            'bull',
            'ioredis',
            'redis',
            'pg',
            'postgres',
            'dockerode',
            '@nestjs',
          ),
        ],
      },
    },
    {
      name: 'mono-controller-production-no-test-code',
      comment:
        "The controller's production code never imports its test code: tests may use the " +
        'database and test helpers, so importing a test file would bridge the rule above.',
      severity: 'error',
      from: { path: '^apps/environment-controller/', pathNot: '(^|/)__tests__/' },
      to: { path: '^apps/environment-controller/.*__tests__/' },
    },
    {
      name: 'mono-controller-process-runner-only',
      comment:
        'Processes start only through the controller process runner, which takes a literal ' +
        'program name from a fixed list: no other production file imports node:child_process.',
      severity: 'error',
      from: {
        path: CONTROLLER_PRODUCTION.path,
        pathNot: [
          CONTROLLER_PRODUCTION.pathNot,
          ...CONTROLLER_PROCESS_FILES.map((file) => `^${file}$`),
        ],
      },
      to: { path: coreModules('child_process') },
    },
    {
      name: 'mono-controller-allowed-imports-only',
      comment:
        "Deny by default: the controller's production code imports only its own files, " +
        '@agentic-studio/contracts, @agentic-studio/compose-validation, zod, yaml and Node core ' +
        'modules, so no other app (the agent worker included), npm or workspace package can ' +
        'reach past the process runner.',
      severity: 'error',
      from: CONTROLLER_PRODUCTION,
      to: { pathNot: CONTROLLER_ALLOWED_IMPORTS, dependencyTypesNot: ['core'] },
    },
    {
      name: 'mono-controller-no-loader-core-modules',
      comment:
        "The controller's production code never imports node:module (createRequire would load " +
        'child_process unseen), node:vm, node:cluster or node:worker_threads.',
      severity: 'error',
      from: CONTROLLER_PRODUCTION,
      to: { path: coreModules('module', 'vm', 'cluster', 'worker_threads') },
    },
    {
      name: 'mono-workspace-imports-resolve',
      comment: 'An unresolved @agentic-studio/* import would silently drop an edge from the graph.',
      severity: 'error',
      from: {},
      to: { path: '^@agentic-studio/', couldNotResolve: true },
    },
    {
      name: 'mono-no-circular',
      comment:
        'No import cycles. Only the generated @hey-api web client is exempt, for cycles between ' +
        'its own files; every other rule applies to it.',
      severity: 'error',
      from: { path: '^(apps|packages)/', pathNot: '^apps/web/src/platform/api/generated/' },
      to: { circular: true },
    },
  ],
  unitCycles: { rule: 'mono-no-workspace-cycle', unit: /^((?:apps|packages)\/[^/]+)\// },
  structural: {
    rules: [
      'mono-manifest-no-app-dependencies',
      'mono-manifest-web-no-server-packages',
      'mono-manifest-no-package-cycles',
      'mono-contracts-no-event-versions',
    ],
    check: (baseDir) => [...manifestViolations(baseDir), ...eventVersionNames(baseDir)],
  },
};

/** The same graph rules at package.json level, where pnpm wires the workspace. */
function manifestViolations(baseDir: string): Violation[] {
  const packages = workspacePackages(baseDir);
  const appNames = new Set(
    packages.filter((pkg) => pkg.dir.startsWith('apps/')).map((pkg) => pkg.name),
  );
  const serverPackage = new RegExp(npmPackages(...SERVER_PACKAGES));
  const violations: Violation[] = [];

  for (const pkg of packages) {
    for (const dependency of pkg.dependencies) {
      if (appNames.has(dependency)) {
        violations.push({
          rule: 'mono-manifest-no-app-dependencies',
          from: pkg.dir,
          to: dependency,
        });
      }
      if (pkg.dir === 'apps/web' && serverPackage.test(dependency)) {
        violations.push({
          rule: 'mono-manifest-web-no-server-packages',
          from: pkg.dir,
          to: dependency,
        });
      }
    }
  }

  const names = new Set(packages.map((pkg) => pkg.name));
  const edges = new Map(
    packages.map((pkg) => [pkg.name, new Set(pkg.dependencies.filter((name) => names.has(name)))]),
  );
  for (const component of stronglyConnectedComponents(edges)) {
    if (component.length > 1) {
      violations.push({
        rule: 'mono-manifest-no-package-cycles',
        from: component.sort().join(' <-> '),
      });
    }
  }
  return violations;
}

/** An integration event definition name (backend.md §6): `<EventName>V<n>` or `...V<n>Schema`. */
const EVENT_VERSION_NAME = /^[A-Z]\w*V\d+(Schema)?$/;

/**
 * `packages/contracts` holds the worker protocol and the shared kernel and no Integration Event:
 * no exported name there is shaped like an event version. Tests are not checked.
 */
function eventVersionNames(baseDir: string): Violation[] {
  return listFiles(baseDir, 'packages/contracts/src')
    .filter((path) => /\.tsx?$/.test(path) && !/(^|\/)__tests__\/|\.test\.tsx?$/.test(path))
    .flatMap((path) => {
      const source = ts.createSourceFile(
        path,
        readFileSync(join(baseDir, path), 'utf8'),
        ts.ScriptTarget.Latest,
      );
      return exportedNames(source)
        .filter((name) => EVENT_VERSION_NAME.test(name))
        .map((name) => ({ rule: 'mono-contracts-no-event-versions', from: path, to: name }));
    });
}
