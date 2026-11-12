import {
  CONCRETE_CLIENT_PACKAGES,
  coreModules,
  INFRASTRUCTURE_PACKAGES,
  listDirectories,
  listFiles,
  npmPackages,
  ORM_PACKAGES,
  type Gate,
  type Violation,
} from '../harness';

const MODULE_FILE = '^src/modules/([^/]+)/\\1\\.module\\.ts$';
const CONTRACTS = '^src/modules/[^/]+/contracts/';
// A built workspace package resolves through its pnpm symlink to packages/<name>/dist/.
const ORM = [npmPackages(...ORM_PACKAGES), '(^|/)packages/database/'];

/**
 * `architecture:api`: the NestJS rules of docs/engineering/quality.md §4 and
 * docs/architecture/backend.md §2–§3. Paths are relative to `apps/api`.
 */
export const apiGate: Gate = {
  entries: ['src'],
  forbidden: [
    {
      name: 'api-no-cross-module-private',
      comment:
        'A business module imports another business module only through its public contracts/.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/', pathNot: ['^src/modules/$1/', CONTRACTS] },
    },
    {
      name: 'api-outside-modules-imports-contracts-only',
      comment:
        'platform/ and shared/ must not reach into business modules except their public contracts/.',
      severity: 'error',
      from: { path: '^src/', pathNot: ['^src/modules/', '^src/app\\.module\\.ts$'] },
      to: { path: '^src/modules/', pathNot: CONTRACTS },
    },
    {
      name: 'api-composition-root-imports-module-files-only',
      comment:
        'Narrow DI wiring exception: the composition root (src/app.module.ts) may import a business ' +
        'module only through its {module}.module.ts or public contracts/.',
      severity: 'error',
      from: { path: '^src/app\\.module\\.ts$' },
      to: { path: '^src/modules/', pathNot: [MODULE_FILE, CONTRACTS] },
    },
    {
      name: 'api-domain-independent',
      comment:
        'domain/ never imports NestJS, ORM, database, Redis, queue, Git, Docker, HTTP, process ' +
        'or infrastructure code.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/domain/' },
      to: {
        path: [
          npmPackages(...INFRASTRUCTURE_PACKAGES),
          '(^|/)packages/database/',
          coreModules(
            'http',
            'https',
            'http2',
            'net',
            'tls',
            'dgram',
            'child_process',
            'cluster',
            'worker_threads',
            'fs',
            'fs/promises',
          ),
          '^src/platform/',
          '^src/modules/[^/]+/(features|consumers|infrastructure)/',
          MODULE_FILE,
        ],
      },
    },
    {
      name: 'api-ports-independent',
      comment:
        'ports/ are interfaces: they never import (or re-export) infrastructure/, features/ or ' +
        'consumers/, the database client, the ORM or concrete clients, so no adapter can be ' +
        'reached through a port.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/ports/' },
      to: {
        path: [
          '^src/modules/[^/]+/(features|consumers|infrastructure)/',
          '^src/platform/database/',
          ...ORM,
          npmPackages(...CONCRETE_CLIENT_PACKAGES),
        ],
      },
    },
    {
      name: 'api-contracts-self-contained',
      comment:
        'A public contracts/ (publisher-owned event schemas and public exports, system.md §6) is ' +
        "self-contained: it never imports or re-exports its own module's domain/, features/, " +
        'consumers/, infrastructure/ or ports/, nor the ORM or concrete clients.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/contracts/' },
      to: {
        path: [
          '^src/modules/$1/(domain|features|consumers|infrastructure|ports)/',
          ...ORM,
          npmPackages(...CONCRETE_CLIENT_PACKAGES),
        ],
      },
    },
    {
      name: 'api-features-no-concrete-adapters',
      comment:
        'Feature handlers and event consumers depend on domain repository contracts and ports, ' +
        'never on concrete repositories, adapters, the database client or concrete infrastructure clients.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/(features|consumers)/' },
      to: {
        path: [
          '^src/modules/[^/]+/infrastructure/',
          '^src/platform/database/',
          ...ORM,
          npmPackages(...CONCRETE_CLIENT_PACKAGES),
        ],
      },
    },
    {
      name: 'api-features-no-reachable-adapters',
      comment:
        'Closes the re-export class of bypasses: no chain of imports (through shared/, platform/, ' +
        'contracts/ or anything else) may lead a feature or consumer to a concrete repository, ' +
        'adapter, the database client, the ORM or a concrete client.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/(features|consumers)/' },
      to: {
        path: [
          '^src/modules/[^/]+/infrastructure/',
          '^src/platform/database/',
          ...ORM,
          npmPackages(...CONCRETE_CLIENT_PACKAGES),
        ],
        reachable: true,
      },
    },
    {
      name: 'api-orm-only-in-infrastructure-repositories',
      comment:
        'Inside business modules, Prisma is used only by infrastructure/repositories/ adapters.',
      severity: 'error',
      from: { path: '^src/modules/', pathNot: '^src/modules/[^/]+/infrastructure/repositories/' },
      to: { path: ORM },
    },
    {
      name: 'api-local-imports-resolve',
      comment: 'An unresolved relative import would silently drop an edge from the graph.',
      severity: 'error',
      from: {},
      to: { path: '^\\.', couldNotResolve: true },
    },
    {
      name: 'api-module-file-composition-root-only',
      comment:
        'Only the composition root (src/app.module.ts) imports a {module}.module.ts; nothing under ' +
        'src/modules/ does, so a module file cannot re-export private code to a handler.',
      severity: 'error',
      from: { path: '^src/modules/' },
      to: { path: MODULE_FILE },
    },
    {
      name: 'api-no-circular',
      comment: 'No import cycles between files, layers or modules.',
      severity: 'error',
      from: { path: '^src/' },
      to: { circular: true },
    },
  ],
  unitCycles: { rule: 'api-no-module-cycle', unit: /^(src\/modules\/[^/]+)\// },
  structural: {
    rules: ['api-module-layout', 'api-feature-has-handler', 'api-infrastructure-placement'],
    check: (baseDir) => [
      ...undocumentedModuleEntries(baseDir),
      ...featuresWithoutHandler(baseDir),
      ...misplacedInfrastructure(baseDir),
    ],
  },
};

/** Folders allowed directly under src/modules/<m>/ (backend.md §2), besides <m>.module.ts. */
const MODULE_FOLDERS = ['features', 'consumers', 'domain', 'ports', 'infrastructure', 'contracts'];

/**
 * A business module contains only the documented folders and its <m>.module.ts, so no
 * undocumented file or folder (helpers.ts, lib/) can re-export private code past the rules.
 */
function undocumentedModuleEntries(baseDir: string): Violation[] {
  return listDirectories(baseDir, 'src/modules').flatMap((module) => {
    const root = `src/modules/${module}`;
    const folders = listDirectories(baseDir, root)
      .filter((folder) => !MODULE_FOLDERS.includes(folder))
      .map((folder) => `${root}/${folder}/`);
    const files = listFiles(baseDir, root)
      .filter((file) => !file.slice(root.length + 1).includes('/'))
      .filter((file) => file !== `${root}/${module}.module.ts`);
    return [...folders, ...files].map((entry) => ({ rule: 'api-module-layout', from: entry }));
  });
}

/** A present use-case feature has a handler.ts (endpoint.ts, schema.ts, input.ts are optional). */
function featuresWithoutHandler(baseDir: string): Violation[] {
  return listDirectories(baseDir, 'src/modules').flatMap((module) => {
    const features = `src/modules/${module}/features`;
    return listDirectories(baseDir, features)
      .map((feature) => `${features}/${feature}`)
      .filter((feature) => !listFiles(baseDir, feature).includes(`${feature}/handler.ts`))
      .map((feature) => ({ rule: 'api-feature-has-handler', from: feature }));
  });
}

/** Concrete repositories live in infrastructure/repositories/, adapters in infrastructure/adapters/. */
function misplacedInfrastructure(baseDir: string): Violation[] {
  return listDirectories(baseDir, 'src/modules').flatMap((module) => {
    const infrastructure = `src/modules/${module}/infrastructure/`;
    return listFiles(baseDir, infrastructure)
      .filter((file) => !/^(repositories|adapters)\//.test(file.slice(infrastructure.length)))
      .map((file) => ({ rule: 'api-infrastructure-placement', from: file }));
  });
}
