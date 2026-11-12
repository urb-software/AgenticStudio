import {
  npmPackages,
  stronglyConnectedComponents,
  workspacePackages,
  type Gate,
  type Violation,
} from '../harness';

/** Server-side or privileged packages the web app must never depend on or import. */
const SERVER_PACKAGES = [
  '@agentic-studio/database',
  '@agentic-studio/testing',
  '@nestjs',
  '@prisma',
  'prisma',
];

/**
 * `architecture:monorepo`: the workspace rules of docs/engineering/quality.md §4 and
 * docs/architecture/system.md §5, for apps/api, apps/web, apps/agent-worker,
 * apps/environment-controller and packages/*. Rules are written per app directory, so
 * they already cover the agent-worker and environment-controller apps, which do not
 * exist yet. Paths are relative to the workspace root.
 */
export const monorepoGate: Gate = {
  entries: ['apps', 'packages'],
  exclude:
    '^(apps|packages)/[^/]+/(node_modules|dist|\\.next|out|coverage)/|^packages/database/src/generated/',
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
      name: 'mono-web-no-server-implementations',
      comment: 'The web app never imports server or privileged implementations.',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: ['^packages/(database|testing)/', npmPackages(...SERVER_PACKAGES)] },
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
      comment: 'No import cycles.',
      severity: 'error',
      from: { path: '^(apps|packages)/' },
      to: { circular: true },
    },
  ],
  unitCycles: { rule: 'mono-no-workspace-cycle', unit: /^((?:apps|packages)\/[^/]+)\// },
  structural: {
    rules: [
      'mono-manifest-no-app-dependencies',
      'mono-manifest-web-no-server-packages',
      'mono-manifest-no-package-cycles',
    ],
    check: manifestViolations,
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
