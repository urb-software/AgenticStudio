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
import { AGGREGATE_RULES, aggregateViolations } from './aggregate-rules';
import { DIRECTION_RULES, directionViolations } from './direction-rules';
import { FILE_RULES, fileViolations } from './file-rules';
import { DOMAIN_FORM_RULES, domainFormViolations } from './domain-form-rules';
import { VALUE_OBJECT_RULES, valueObjectViolations } from './value-object-rules';
import { LAYOUT_RULES, APPLICATION_FORBIDDEN_PACKAGES, layoutViolations } from './layout-rules';
import { SECRETS_SOURCE_RULES, secretsViolations } from './secrets-rules';
import { SOURCE_RULES, sourceViolations } from './source-rules';

const MODULE_FILE = '^src/modules/([^/]+)/\\1\\.module\\.ts$';
const SECRETS_DIR = '^src/platform/secrets/';
/** The secrets capability's two entry points (backend.md §2): the port and the Nest wiring. */
const SECRETS_ENTRY_POINTS = '^src/platform/secrets/(index|secrets\\.module)\\.ts$';
const CONTRACTS = '^src/modules/[^/]+/contracts/';
/**
 * Feature handlers and application collaborators (not the interfaces in application/ports/,
 * which api-ports-independent covers), and the entry points that call them.
 */
const APPLICATION_AND_ENTRY_POINTS = '^src/modules/[^/]+/(application/(?!ports/)|entry-points/)';
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
      name: 'api-cross-module-contracts-index-only',
      comment:
        'Another module is reached only through its public contracts/index.ts. The shared HTTP ' +
        'shapes of a module live in its entry-points/http/shared/, which api-no-cross-module-private ' +
        'keeps private (backend.md §2, Issue #96). Deep imports of contracts/events/ are covered by ' +
        'api-events-imported-via-contracts-index.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: CONTRACTS,
        pathNot: [
          '^src/modules/$1/',
          '^src/modules/[^/]+/contracts/index\\.ts$',
          '^src/modules/[^/]+/contracts/events/',
        ],
      },
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
          '^src/modules/[^/]+/(application/(?!ports/)|entry-points/|infrastructure/)',
          MODULE_FILE,
        ],
      },
    },
    {
      name: 'api-domain-no-ports',
      comment:
        'domain/ receives facts as values and never fetches them (backend.md §3 rule 6): it ' +
        'imports nothing from application/ports/, which hold the interfaces a handler uses to ' +
        'look things up.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/domain/' },
      to: { path: '^src/modules/[^/]+/application/ports/' },
    },
    {
      name: 'api-domain-tests-no-database-or-containers',
      comment:
        'The tests of domain/ need no database and no container (backend.md §3 rule 6, ' +
        'quality.md §4): they import no ORM, database client, concrete client, container ' +
        'tooling or the shared test containers package.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/domain/.*(__tests__/|\\.test\\.tsx?$)' },
      to: {
        path: [
          npmPackages(
            ...ORM_PACKAGES,
            'testcontainers',
            '@testcontainers',
            '@agentic-studio/testing',
          ),
          CONCRETE_CLIENTS,
          '(^|/)packages/(database|testing)/',
          '^src/platform/database/',
        ],
      },
    },
    {
      name: 'api-ports-independent',
      comment:
        'application/ports/ are interfaces: they never import (or re-export) infrastructure/, ' +
        'entry-points/ or the rest of application/, the database client, the ORM or concrete ' +
        'clients, so no adapter can be reached through a port.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/application/ports/' },
      to: {
        path: [
          '^src/modules/[^/]+/(application/(?!ports/)|entry-points/|infrastructure/)',
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
        "self-contained: it never imports or re-exports its own module's domain/, application/, " +
        'entry-points/ or infrastructure/, nor the ORM or concrete clients.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/contracts/' },
      to: {
        path: [
          '^src/modules/$1/(domain|application|entry-points|infrastructure)/',
          ...ORM,
          CONCRETE_CLIENTS,
        ],
      },
    },
    {
      name: 'api-features-no-concrete-adapters',
      comment:
        'Feature handlers, entry points (endpoints, event consumers) depend on domain repository ' +
        'contracts and ports, never on concrete repositories, adapters, the database client or ' +
        'concrete infrastructure clients.',
      severity: 'error',
      from: { path: APPLICATION_AND_ENTRY_POINTS },
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
        'contracts/ or anything else) may lead a feature or an entry point to a concrete ' +
        'repository, adapter, the database client, the ORM or a concrete client.',
      severity: 'error',
      from: { path: APPLICATION_AND_ENTRY_POINTS },
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
      name: 'api-application-no-http-queue-scheduler-libraries',
      comment:
        'application/ knows nothing about HTTP, request schemas, OpenAPI, queues or timers: it ' +
        'imports no request-schema or OpenAPI library, no HTTP server or client, no queue or ' +
        'scheduler API (backend.md §3 rule 2). Controller and parameter decorators from ' +
        '@nestjs/common are covered by api-application-no-http-decorators, and platform/queue/ ' +
        'by api-application-no-platform-queue. Plain zod stays allowed here.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/application/' },
      to: {
        path: [
          npmPackages(...APPLICATION_FORBIDDEN_PACKAGES),
          coreModules('http', 'https', 'http2'),
        ],
      },
    },
    {
      name: 'api-application-no-platform-queue',
      comment:
        'application/ knows nothing about queues (backend.md §3 rule 2): it imports nothing from ' +
        'platform/queue/. A job is started and cancelled through a port whose adapter lives in ' +
        "infrastructure/, and the job's events reach a handler through an entry point. The tests " +
        "of application/ (__tests__/) may import the queue port's error classes, to make a " +
        'fake adapter fail the way the real one does.',
      severity: 'error',
      from: {
        path: '^src/modules/[^/]+/application/',
        pathNot: '(^|/)__tests__/|\\.test\\.ts$',
      },
      to: { path: '^src/platform/queue/' },
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
        "HandledServerErrorException (the platform's unlogged 503 marker) is platform-only: no " +
        'chain of imports leads business-module production code to it. Modules answer a handled ' +
        '503 with serviceUnavailable() from platform/http/problem-details.ts (Issue #70). This ' +
        'does not stop a module from throwing an unlogged 5xx ProblemException. ' +
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
      ...LAYOUT_RULES,
      ...AGGREGATE_RULES,
      ...FILE_RULES,
      ...VALUE_OBJECT_RULES,
      ...DOMAIN_FORM_RULES,
      ...DIRECTION_RULES,
      ...SECRETS_SOURCE_RULES,
    ],
    check: (baseDir) => [
      ...undocumentedModuleEntries(baseDir),
      ...featuresWithoutHandler(baseDir),
      ...misplacedInfrastructure(baseDir),
      ...sourceViolations(baseDir),
      ...layoutViolations(baseDir),
      ...aggregateViolations(baseDir),
      ...fileViolations(baseDir),
      ...valueObjectViolations(baseDir),
      ...domainFormViolations(baseDir),
      ...directionViolations(baseDir),
      ...secretsViolations(baseDir),
    ],
  },
};

/** Folders allowed directly under src/modules/<m>/ (backend.md §2), besides <m>.module.ts. */
const MODULE_FOLDERS = ['application', 'domain', 'entry-points', 'infrastructure', 'contracts'];

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

/** A present use-case feature has a handler.ts (input.ts and __tests__/ are optional). */
function featuresWithoutHandler(baseDir: string): Violation[] {
  return listDirectories(baseDir, 'src/modules').flatMap((module) => {
    const features = `src/modules/${module}/application/features`;
    return listDirectories(baseDir, features)
      .map((feature) => `${features}/${feature}`)
      .filter((feature) => !listFiles(baseDir, feature).includes(`${feature}/handler.ts`))
      .map((feature) => ({ rule: 'api-feature-has-handler', from: feature }));
  });
}

/** Repositories live in infrastructure/repositories/, adapters in infrastructure/adapters/. */
function misplacedInfrastructure(baseDir: string): Violation[] {
  return listDirectories(baseDir, 'src/modules').flatMap((module) => {
    const infrastructure = `src/modules/${module}/infrastructure/`;
    return listFiles(baseDir, infrastructure)
      .filter((file) => !/^(repositories|adapters)\//.test(file.slice(infrastructure.length)))
      .map((file) => ({ rule: 'api-infrastructure-placement', from: file }));
  });
}
