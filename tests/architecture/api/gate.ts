import {
  CONCRETE_CLIENTS,
  importsResolveRules,
  WORKSPACE_PACKAGES_FROM_SOURCE,
  coreModules,
  INFRASTRUCTURE_PACKAGES,
  listDirectories,
  listFiles,
  npmPackages,
  ORM_PACKAGES,
  type Gate,
  type Violation,
} from '../harness';
import { SECRETS_SOURCE_RULES, secretsViolations } from './secrets-rules';
import { SOURCE_RULES, sourceViolations } from './source-rules';

const MODULE_FILE = '^src/modules/([^/]+)/\\1\\.module\\.ts$';
const SECRETS_DIR = '^src/platform/secrets/';
/** The secrets capability's two entry points (backend.md §2): the port and the Nest wiring. */
const SECRETS_ENTRY_POINTS = '^src/platform/secrets/(index|secrets\\.module)\\.ts$';
const CONTRACTS = '^src/modules/[^/]+/contracts/';
/** Test files, which may boot the whole app. */
const TESTS = '(^|/)__tests__/';
// Workspace packages resolve to their source (`../../packages/database/src/` from apps/api).
const ORM = [npmPackages(...ORM_PACKAGES), '(^|/)packages/database/'];

/**
 * `architecture:api`: the NestJS rules of docs/engineering/quality.md §4 and
 * docs/architecture/backend.md §2–§3. Paths are relative to `apps/api`.
 */
export const apiGate: Gate = {
  entries: ['src'],
  // A re-export through a workspace package stays in the graph.
  ...WORKSPACE_PACKAGES_FROM_SOURCE,
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
      name: 'api-events-imported-via-contracts-index',
      comment:
        "Another module consumes an integration event only through the publisher's " +
        'contracts/index.ts, never by deep-importing contracts/events/<file> (backend.md §6).',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/[^/]+/contracts/events/', pathNot: '^src/modules/$1/' },
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
          CONCRETE_CLIENTS,
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
          CONCRETE_CLIENTS,
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
          CONCRETE_CLIENTS,
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
          CONCRETE_CLIENTS,
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
          CONCRETE_CLIENTS,
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
    ...importsResolveRules('api', '^(\\.|@agentic-studio/)'),
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
      name: 'api-secrets-via-entry-points',
      comment:
        'Outside platform/secrets/, the secrets capability is reached only through its port ' +
        '(index.ts) and its Nest wiring (secrets.module.ts), never its adapter or AES-GCM code ' +
        '(ADR 0001, backend.md §2).',
      severity: 'error',
      from: { pathNot: SECRETS_DIR },
      to: { path: SECRETS_DIR, pathNot: SECRETS_ENTRY_POINTS },
    },
    {
      name: 'api-secrets-module-in-module-files',
      comment:
        'Only a Nest module file (*.module.ts) imports secrets.module.ts; code that uses secrets ' +
        'injects SECRET_STORE from platform/secrets/index.ts.',
      severity: 'error',
      from: { pathNot: [SECRETS_DIR, '\\.module\\.ts$'] },
      to: { path: '^src/platform/secrets/secrets\\.module\\.ts$' },
    },
    {
      name: 'api-handled-server-error-platform-only',
      comment:
        'HandledServerErrorException (an unlogged 503) is platform-only: no chain of imports leads ' +
        'a business module to it, so a module cannot silence a real 5xx; modules answer a handled ' +
        '503 with serviceUnavailable() from platform/http/problem-details.ts (Issue #70). ' +
        'Module tests are exempt from the chain check only (an existing adapter test under ' +
        'infrastructure/ boots the whole app); direct imports stay forbidden below.',
      severity: 'error',
      from: { path: '^src/modules/', pathNot: TESTS },
      to: { path: '^src/platform/http/handled-server-error\\.ts$', reachable: true },
    },
    {
      name: 'api-queue-health-platform-only',
      comment:
        "The queue's health view (QueueHealth and its provider) is platform-only: no chain of " +
        'imports leads a business module to it; modules use the JobQueues port (Issue #70). ' +
        'Module tests are exempt from the chain check only; direct imports stay forbidden below.',
      severity: 'error',
      from: { path: '^src/modules/', pathNot: TESTS },
      to: { path: '^src/platform/queue/queue-health(\\.provider)?\\.ts$', reachable: true },
    },
    {
      name: 'api-platform-only-http-and-queue-health-imports',
      comment:
        'No file under src/modules/, tests included, imports HandledServerErrorException or the ' +
        "queue's health view directly; the two reachable rules above cover production code " +
        'through any chain (Issue #70).',
      severity: 'error',
      from: { path: '^src/modules/' },
      to: {
        path: [
          '^src/platform/http/handled-server-error\\.ts$',
          '^src/platform/queue/queue-health(\\.provider)?\\.ts$',
        ],
      },
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
    rules: [
      'api-module-layout',
      'api-feature-has-handler',
      'api-infrastructure-placement',
      ...SOURCE_RULES,
      ...SECRETS_SOURCE_RULES,
    ],
    check: (baseDir) => [
      ...undocumentedModuleEntries(baseDir),
      ...featuresWithoutHandler(baseDir),
      ...misplacedInfrastructure(baseDir),
      ...sourceViolations(baseDir),
      ...secretsViolations(baseDir),
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
