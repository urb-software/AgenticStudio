import {
  npmPackages,
  SERVER_PACKAGES,
  stronglyConnectedComponents,
  workspacePackages,
  type Gate,
  type Violation,
} from '../harness';

/**
 * `architecture:monorepo`: the workspace rules of docs/engineering/quality.md §4 and
 * docs/architecture/system.md §5, for apps/api, apps/web, apps/agent-worker,
 * apps/environment-controller and packages/*. Rules are written per app directory, so
 * they already cover the agent-worker and environment-controller apps, which do not
 * exist yet. Paths are relative to the workspace root.
 */
/**
 * Every packages/* workspace package must be listed here as allowed or forbidden for
 * apps/web (a meta-test enforces it), so a new server-only package cannot reach the web
 * app by default. Forbidden names must also be in SERVER_PACKAGES, which the rules use.
 */
export const WEB_PACKAGE_CLASSIFICATION: { allowed: string[]; forbidden: string[] } = {
  allowed: [],
  forbidden: ['@agentic-studio/database', '@agentic-studio/testing'],
};

export const monorepoGate: Gate = {
  entries: ['apps', 'packages'],
  exclude: '^(apps|packages)/[^/]+/(node_modules|dist|\\.next|out|coverage)/',
  // Generated code (Prisma client, @hey-api web client): kept as graph leaves, so imports
  // of it are still checked but its internals are not.
  doNotFollow: '^(packages/database/src/generated|apps/web/src/platform/api/generated)/',
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
