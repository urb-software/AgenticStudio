import { describeGate } from '../suite';
import { apiGate } from './gate';

describeGate('api', apiGate, 'apps/api', [
  {
    fixture: 'handler-imports-own-port',
    expected: [],
    qualityRow: 'Handler imports a port from its own module',
  },
  {
    fixture: 'handler-imports-other-module-private-repository',
    expected: [
      'api-no-cross-module-private',
      'api-features-no-concrete-adapters',
      'api-features-no-reachable-adapters',
    ],
    qualityRow: "Handler imports another module's private repository",
  },
  {
    fixture: 'domain-imports-orm',
    expected: ['api-domain-independent', 'api-orm-only-in-infrastructure-repositories'],
    qualityRow: 'Domain imports ORM/NestJS',
  },
  {
    fixture: 'domain-imports-nestjs',
    expected: ['api-domain-independent'],
    qualityRow: 'Domain imports ORM/NestJS',
  },
  {
    fixture: 'consumer-imports-public-versioned-event',
    expected: [],
    qualityRow: 'Consumer imports publisher-owned public versioned event',
  },
  {
    fixture: 'modules-cycle-through-contracts',
    expected: ['api-no-module-cycle'],
    qualityRow: 'Two modules introduce a dependency cycle',
  },
  { fixture: 'domain-imports-infrastructure', expected: ['api-domain-independent'] },
  {
    fixture: 'handler-imports-own-concrete-adapter',
    expected: ['api-features-no-concrete-adapters', 'api-features-no-reachable-adapters'],
  },
  {
    fixture: 'handler-imports-database-client',
    expected: ['api-features-no-concrete-adapters', 'api-features-no-reachable-adapters'],
  },
  { fixture: 'file-cycle', expected: ['api-no-circular'] },
  {
    fixture: 'orm-outside-infrastructure-repositories',
    expected: ['api-orm-only-in-infrastructure-repositories'],
  },
  { fixture: 'prisma-repository-in-infrastructure', expected: [] },
  {
    fixture: 'composition-root-imports-module-internals',
    expected: ['api-composition-root-imports-module-files-only'],
  },
  {
    fixture: 'platform-imports-module-internals',
    expected: ['api-outside-modules-imports-contracts-only'],
  },
  { fixture: 'feature-without-handler', expected: ['api-feature-has-handler'] },
  {
    fixture: 'infrastructure-file-outside-repositories-or-adapters',
    expected: ['api-infrastructure-placement'],
  },
  {
    fixture: 'handler-imports-queue-client',
    expected: [
      'api-application-no-http-queue-scheduler-libraries',
      'api-features-no-concrete-adapters',
      'api-features-no-reachable-adapters',
    ],
  },
  { fixture: 'domain-imports-docker-client', expected: ['api-domain-independent'] },
  { fixture: 'unresolved-relative-import', expected: ['api-local-imports-resolve'] },
  {
    fixture: 'handler-imports-adapter-via-port',
    expected: ['api-ports-independent', 'api-features-no-reachable-adapters'],
  },
  {
    fixture: 'contracts-reexport-infrastructure',
    expected: ['api-contracts-self-contained', 'api-features-no-reachable-adapters'],
  },
  { fixture: 'contracts-import-domain', expected: ['api-contracts-self-contained'] },
  { fixture: 'domain-imports-file-system', expected: ['api-domain-independent'] },
  {
    fixture: 'module-root-file-reexports-adapter',
    expected: ['api-module-layout', 'api-features-no-reachable-adapters'],
  },
  {
    fixture: 'undocumented-folder-reexports-adapter',
    expected: ['api-module-layout', 'api-features-no-reachable-adapters'],
  },
  {
    fixture: 'handler-imports-module-file',
    expected: ['api-module-file-composition-root-only', 'api-features-no-reachable-adapters'],
  },
  {
    fixture: 'port-reexports-database-client',
    expected: ['api-ports-independent', 'api-features-no-reachable-adapters'],
  },
  { fixture: 'handler-legitimate-dependencies', expected: [] },
  { fixture: 'shared-reexports-database-client', expected: ['api-features-no-reachable-adapters'] },
  { fixture: 'shared-reexports-concrete-client', expected: ['api-features-no-reachable-adapters'] },
  {
    fixture: 'platform-reexports-database-client',
    expected: ['api-features-no-reachable-adapters'],
  },
  {
    fixture: 'contracts-reexport-database-client',
    expected: ['api-features-no-reachable-adapters'],
  },
  { fixture: 'events-versioned-and-publisher-owned', expected: [] },
  {
    fixture: 'event-unversioned-export',
    expected: ['api-event-versioned'],
    qualityRow: 'Module publishes an unversioned integration event',
  },
  { fixture: 'event-export-version-mismatch', expected: ['api-event-versioned'] },
  { fixture: 'event-defined-outside-contracts', expected: ['api-event-publisher-owned'] },
  {
    fixture: 'event-reexports-foreign-event',
    expected: ['api-event-publisher-owned', 'api-event-no-duplicates'],
  },
  {
    fixture: 'event-duplicated-across-modules',
    expected: ['api-event-no-duplicates'],
    qualityRow: 'Two modules define the same integration event',
  },
  { fixture: 'contracts-in-domain-repositories-and-ports', expected: [] },
  {
    fixture: 'repository-contract-outside-domain-repositories',
    expected: ['api-repository-contract-placement'],
    qualityRow: 'Repository contract declared outside `domain/repositories/`',
  },
  { fixture: 'read-port-in-domain-repositories', expected: ['api-repository-contract-placement'] },
  {
    fixture: 'adapter-implements-contract-outside-ports',
    expected: ['api-adapter-contract-placement'],
  },
  { fixture: 'adapter-declares-own-contract', expected: ['api-adapter-contract-placement'] },
  { fixture: 'repository-imports-workspace-database-package', expected: [] },
  {
    fixture: 'workspace-package-reexports-concrete-client',
    expected: ['api-features-no-reachable-adapters'],
  },
  { fixture: 'unresolved-workspace-import', expected: ['api-local-imports-resolve'] },
  {
    fixture: 'handler-imports-framework-queue-integration',
    expected: [
      'api-application-no-http-queue-scheduler-libraries',
      'api-features-no-concrete-adapters',
      'api-features-no-reachable-adapters',
    ],
  },
  { fixture: 'port-imports-framework-orm-integration', expected: ['api-ports-independent'] },
  { fixture: 'contracts-reexport-client-wrapper', expected: ['api-contracts-self-contained'] },
  { fixture: 'event-declared-in-contracts-root', expected: ['api-event-versioned'] },
  {
    fixture: 'adapter-implements-contract-via-ports-barrel',
    expected: ['api-adapter-contract-placement'],
  },
  {
    fixture: 'handler-imports-pattern-only-client',
    expected: ['api-features-no-concrete-adapters', 'api-features-no-reachable-adapters'],
  },
  {
    fixture: 'event-republished-by-other-module',
    expected: ['api-event-publisher-owned'],
    qualityRow: 'Integration event re-exported by another module or under another name',
  },
  { fixture: 'event-unversioned-export-alias', expected: ['api-event-publisher-owned'] },
  { fixture: 'event-unversioned-type-alias', expected: ['api-event-publisher-owned'] },
  { fixture: 'event-renamed-by-consumer', expected: ['api-event-publisher-owned'] },
  {
    fixture: 'consumer-deep-imports-event-file',
    expected: ['api-events-imported-via-contracts-index'],
  },
  { fixture: 'http-dto-named-event', expected: [] },
  { fixture: 'unresolved-generated-client-import', expected: ['api-local-imports-resolve'] },
  {
    fixture: 'database-package-unresolved-import',
    expected: ['api-database-package-imports-resolve'],
  },
  { fixture: 'port-aliases-contract-outside-ports', expected: ['api-adapter-contract-placement'] },
  { fixture: 'event-default-export', expected: ['api-event-publisher-owned'] },
  { fixture: 'event-namespace-alias', expected: ['api-event-publisher-owned'] },
  { fixture: 'event-namespace-reexport', expected: ['api-event-publisher-owned'] },
  { fixture: 'event-interface-alias', expected: ['api-event-publisher-owned'] },
  // SecretStore boundary (ADR 0001, backend.md §2, Issue #57).
  { fixture: 'secrets-used-through-entry-points', expected: [] },
  { fixture: 'module-imports-secrets-internals', expected: ['api-secrets-via-entry-points'] },
  {
    fixture: 'secrets-module-imported-outside-module-file',
    expected: ['api-secrets-module-in-module-files'],
  },
  { fixture: 'module-uses-secret-model', expected: ['api-secret-model-in-secrets-only'] },
  { fixture: 'module-reads-secrets-key', expected: ['api-secrets-key-reads'] },
  // Platform-only handled 503 and queue health view (Issue #70).
  { fixture: 'platform-only-handled-error-and-queue-health', expected: [] },
  {
    fixture: 'module-imports-handled-server-error',
    expected: [
      'api-handled-server-error-platform-only',
      'api-platform-only-http-and-queue-health-imports',
    ],
  },
  {
    fixture: 'module-reaches-handled-server-error-via-problem-details',
    expected: ['api-handled-server-error-platform-only'],
  },
  {
    fixture: 'module-test-imports-handled-server-error',
    expected: ['api-platform-only-http-and-queue-health-imports'],
  },
  {
    fixture: 'module-reaches-queue-health-via-port',
    expected: ['api-queue-health-platform-only'],
  },
  // Cross-module use through the public contracts/index.ts only (backend.md §2, Issue #96).
  { fixture: 'module-uses-other-module-public-contract', expected: [] },
  {
    fixture: 'module-imports-other-module-http-contract',
    expected: ['api-contracts-only-index-and-events', 'api-cross-module-contracts-index-only'],
  },
  { fixture: 'module-imports-other-module-http-shared', expected: ['api-no-cross-module-private'] },
  // The checks the approved module layout makes possible (Issue #162).
  {
    fixture: 'application-imports-only-domain-ports-and-own-files',
    expected: [],
    qualityRow: '`application/` imports only domain, ports and its own files',
  },
  {
    fixture: 'application-imports-schema-openapi-and-scheduler-libraries',
    expected: ['api-application-no-http-queue-scheduler-libraries'],
    qualityRow: '`application/` imports an HTTP, schema, OpenAPI, queue or scheduler API',
  },
  {
    fixture: 'application-imports-platform-queue',
    expected: ['api-application-no-platform-queue'],
    qualityRow: '`application/` imports an HTTP, schema, OpenAPI, queue or scheduler API',
  },
  // A test of `application/` may import the queue port's error classes (Issue #164).
  {
    fixture: 'application-test-imports-platform-queue',
    expected: [],
    qualityRow: 'A test of `application/` imports `platform/queue/` (tests are not checked)',
  },
  {
    fixture: 'application-imports-http-decorators',
    expected: ['api-application-no-http-decorators'],
    qualityRow: '`application/` imports an HTTP, schema, OpenAPI, queue or scheduler API',
  },
  {
    fixture: 'entry-point-imports-handlers-schemas-shared-shapes-and-domain-errors',
    expected: [],
    qualityRow: '`entry-points/` imports a handler',
  },
  {
    fixture: 'entry-point-imports-repository-interface',
    expected: ['api-entry-points-no-ports-or-infrastructure'],
    qualityRow: '`entry-points/` imports a repository interface, port or infrastructure file',
  },
  {
    fixture: 'entry-point-imports-port-token',
    expected: ['api-entry-points-no-ports-or-infrastructure'],
    qualityRow: '`entry-points/` imports a repository interface, port or infrastructure file',
  },
  {
    fixture: 'entry-point-imports-infrastructure',
    expected: [
      'api-entry-points-no-ports-or-infrastructure',
      'api-features-no-concrete-adapters',
      'api-features-no-reachable-adapters',
    ],
    qualityRow: '`entry-points/` imports a repository interface, port or infrastructure file',
  },
  {
    fixture: 'entry-point-imports-operator-sessions-and-log-settings-ports',
    expected: ['api-entry-points-no-ports-or-infrastructure'],
    qualityRow: '`entry-points/` imports a repository interface, port or infrastructure file',
  },
  // Features are independent, in `executions` (Issue #166) and `projects` (Issue #164).
  {
    fixture: 'projects-feature-imports-own-files-ports-and-domain',
    expected: [],
    qualityRow: 'A feature imports a port, the domain or its own files',
  },
  {
    fixture: 'projects-feature-imports-another-feature',
    expected: ['api-features-no-feature-imports'],
    qualityRow: 'A feature imports another feature of its module',
  },
  {
    fixture: 'feature-imports-own-files-ports-and-domain',
    expected: [],
    qualityRow: 'A feature imports a port, the domain or its own files',
  },
  {
    fixture: 'feature-imports-another-feature-handler',
    expected: ['api-features-no-feature-imports'],
    qualityRow: 'A feature imports another feature of its module',
  },
  {
    fixture: 'feature-imports-another-feature-error',
    expected: ['api-features-no-feature-imports'],
    qualityRow: 'A feature imports another feature of its module',
  },
  {
    fixture: 'feature-reexports-another-feature',
    expected: ['api-features-no-feature-imports'],
    qualityRow: 'A feature imports another feature of its module',
  },
  {
    fixture: 'feature-imports-another-feature-type-only',
    expected: ['api-features-no-feature-imports'],
    qualityRow: 'A feature imports another feature of its module',
  },
  {
    fixture: 'feature-imports-another-feature-nested-file',
    expected: ['api-features-no-feature-imports'],
    qualityRow: 'A feature imports another feature of its module',
  },
  {
    fixture: 'feature-test-imports-another-feature',
    expected: [],
    qualityRow: 'A test of a feature imports another feature (tests are not checked)',
  },
  {
    fixture: 'production-file-imports-test-helper',
    expected: ['api-production-no-test-imports'],
    qualityRow: 'A production file of a module imports a test file',
  },
  {
    fixture: 'production-file-imports-test-file',
    expected: ['api-production-no-test-imports'],
    qualityRow: 'A production file of a module imports a test file',
  },
  {
    fixture: 'production-file-reexports-test-helper',
    expected: ['api-production-no-test-imports'],
    qualityRow: 'A production file of a module imports a test file',
  },
  {
    fixture: 'test-file-imports-test-helper',
    expected: [],
    qualityRow: 'A test file imports a test helper',
  },
  {
    fixture: 'entry-point-imports-several-features',
    expected: [],
    qualityRow: '`entry-points/` imports a handler',
  },
  {
    fixture: 'contracts-index-and-events-only',
    expected: [],
    qualityRow: '`contracts/` holds `index.ts` and `events/` only',
  },
  {
    fixture: 'contracts-holds-extra-file',
    expected: ['api-contracts-only-index-and-events'],
    qualityRow: '`contracts/` holds another file',
  },
  {
    fixture: 'contracts-holds-extra-directory',
    expected: ['api-contracts-only-index-and-events'],
    qualityRow: '`contracts/` holds another directory',
  },
  {
    fixture: 'http-shared-directory-is-the-one-exemption',
    expected: [],
    qualityRow: 'A module has `entry-points/http/shared/` (the one exemption)',
  },
  {
    fixture: 'shared-directory-outside-http-shared',
    expected: ['api-no-shared-common-utils-helpers-directory'],
    qualityRow:
      'A module has a `shared`, `common`, `utils` or `helpers` directory, e.g. `application/shared/`',
  },
  {
    fixture: 'http-shared-subdirectory-utils',
    expected: ['api-no-shared-common-utils-helpers-directory'],
    qualityRow:
      'A subdirectory of `entry-points/http/shared/` is named `shared`, `common`, `utils` or `helpers`',
  },
  {
    fixture: 'entry-points-shared-directory-outside-http',
    expected: ['api-no-shared-common-utils-helpers-directory'],
  },
  {
    fixture: 'http-caller-shared-directory',
    expected: ['api-no-shared-common-utils-helpers-directory'],
  },
  {
    fixture: 'domain-helpers-directory',
    expected: ['api-no-shared-common-utils-helpers-directory'],
  },
  {
    fixture: 'infrastructure-common-directory',
    expected: ['api-no-shared-common-utils-helpers-directory'],
  },
  {
    fixture: 'feature-utils-directory',
    expected: ['api-no-shared-common-utils-helpers-directory'],
  },
  {
    fixture: 'application-imports-nestjs-common-as-namespace',
    expected: ['api-application-no-http-decorators'],
    qualityRow: '`application/` imports an HTTP, schema, OpenAPI, queue or scheduler API',
  },
  {
    fixture: 'entity-class-with-private-constructor',
    expected: [],
    qualityRow: '`domain/entities/` file exports a class with a non-public constructor',
  },
  {
    fixture: 'entity-class-with-protected-constructor',
    expected: [],
    qualityRow: '`domain/entities/` file exports a class with a non-public constructor',
  },
  {
    fixture: 'entity-class-exported-in-a-list',
    expected: [],
    qualityRow: '`domain/entities/` file exports a class with a non-public constructor',
  },
  {
    fixture: 'entity-tests-and-value-objects-are-not-checked',
    expected: [],
    qualityRow: '`domain/entities/` file exports a class with a non-public constructor',
  },
  {
    fixture: 'entity-class-with-public-constructor',
    expected: ['api-entities-are-classes-with-non-public-constructors'],
    qualityRow: '`domain/entities/` file exports a class with a public constructor, or no class',
  },
  {
    fixture: 'entity-class-with-implicit-constructor',
    expected: ['api-entities-are-classes-with-non-public-constructors'],
    qualityRow: '`domain/entities/` file exports a class with a public constructor, or no class',
  },
  {
    fixture: 'entity-file-exports-a-plain-record',
    expected: ['api-entities-are-classes-with-non-public-constructors'],
    qualityRow: '`domain/entities/` file exports a class with a public constructor, or no class',
  },
  {
    fixture: 'entity-file-exports-only-an-error-class',
    expected: ['api-entities-are-classes-with-non-public-constructors'],
    qualityRow: '`domain/entities/` file exports a class with a public constructor, or no class',
  },
  {
    fixture: 'entity-class-with-private-constructor-and-a-public-one',
    expected: ['api-entities-are-classes-with-non-public-constructors'],
    qualityRow: '`domain/entities/` file exports a class with a public constructor, or no class',
  },
  // `domain/` has no services, imports no port, and its tests need no database (Issue #168).
  {
    fixture: 'domain-has-no-services-directory',
    expected: [],
    qualityRow: 'A module has no `domain/services/` directory',
  },
  {
    fixture: 'domain-has-services-directory',
    expected: ['api-no-domain-services-directory'],
    qualityRow: 'A module has a `domain/services/` directory',
  },
  {
    fixture: 'domain-imports-only-domain-and-plain-libraries',
    expected: [],
    qualityRow: '`domain/` imports only `domain/` and plain libraries',
  },
  {
    fixture: 'domain-imports-application-port',
    expected: ['api-domain-no-ports'],
    qualityRow: '`domain/` imports from `application/ports/`',
  },
  {
    fixture: 'domain-test-imports-domain-and-test-helpers',
    expected: [],
    qualityRow: 'A domain test imports only the domain and test helpers',
  },
  {
    fixture: 'domain-test-imports-container-tooling',
    expected: ['api-domain-tests-no-database-or-containers'],
    qualityRow: 'A domain test imports a database client or container tooling',
  },
  {
    fixture: 'domain-test-imports-database-client',
    expected: [
      'api-domain-independent',
      'api-domain-tests-no-database-or-containers',
      'api-orm-only-in-infrastructure-repositories',
    ],
    qualityRow: 'A domain test imports a database client or container tooling',
  },
  {
    fixture: 'entity-projects-class-with-private-constructor',
    expected: [],
    qualityRow: '`domain/entities/` file exports a class with a non-public constructor',
  },
  {
    fixture: 'entity-projects-file-exports-a-plain-record',
    expected: ['api-entities-are-classes-with-non-public-constructors'],
    qualityRow: '`domain/entities/` file exports a class with a public constructor, or no class',
  },
  // Aggregate roots and handler results (Issue #182): `projects`; `executions` is added by #183.
  {
    fixture: 'entry-point-imports-entity-type',
    expected: [],
    qualityRow: '`entry-points/` imports a type from `domain/entities/`',
  },
  {
    fixture: 'entry-point-imports-entity-class',
    expected: ['api-entry-points-no-entity-classes'],
    qualityRow: '`entry-points/` imports a class from `domain/entities/`',
  },
  {
    fixture: 'handler-returns-snapshot-and-exports-input-and-result',
    expected: [],
    qualityRow:
      'A handler returns a snapshot, ids, values or a view type, and exports its input and result types',
  },
  {
    fixture: 'handler-returns-entity-class',
    expected: ['api-handlers-return-plain-data'],
    qualityRow: 'A handler returns an entity class, or does not export its result type',
  },
  {
    fixture: 'handler-result-wraps-entity-class',
    expected: ['api-handlers-return-plain-data'],
    qualityRow: 'A handler returns an entity class, or does not export its result type',
  },
  {
    fixture: 'handler-does-not-export-result-type',
    expected: ['api-handlers-return-plain-data'],
    qualityRow: 'A handler returns an entity class, or does not export its result type',
  },
  {
    fixture: 'repository-refers-to-one-entity-file',
    expected: [],
    qualityRow: 'A repository interface refers to one entity file',
  },
  {
    fixture: 'repository-refers-to-two-entity-files',
    expected: ['api-repository-refers-to-one-entity'],
    qualityRow:
      'A repository interface refers to two entity files, or its main type is under `domain/value-objects/`',
  },
  {
    fixture: 'repository-returns-value-object-type',
    expected: ['api-repository-refers-to-one-entity'],
    qualityRow:
      'A repository interface refers to two entity files, or its main type is under `domain/value-objects/`',
  },
  {
    fixture: 'entity-imports-entity-id-type',
    expected: [],
    qualityRow: 'An entity file imports another entity file for an id type',
  },
  {
    fixture: 'entity-imports-another-entity',
    expected: ['api-entities-do-not-import-entities'],
    qualityRow: 'An entity file imports another entity file for anything else',
  }, // Rule 13, one concept per file (Issue #185): `projects`; `executions` is added by #184.
  {
    fixture: 'entity-projects-one-class-and-nothing-else',
    expected: [],
    qualityRow: 'A `domain/entities/` file exports exactly one class and no function',
  },
  {
    fixture: 'entity-projects-class-and-error-class',
    expected: ['api-entity-file-exports-one-class-and-no-function'],
    qualityRow: 'A `domain/entities/` file exports a second class or any function',
  },
  {
    fixture: 'entity-projects-class-and-function',
    expected: [
      'api-entity-file-exports-one-class-and-no-function',
      'api-domain-exports-no-function-but-type-guards',
    ],
    qualityRow: 'A `domain/entities/` file exports a second class or any function',
  },
  {
    fixture: 'entity-projects-class-and-type-guard-function',
    expected: ['api-entity-file-exports-one-class-and-no-function'],
    qualityRow: 'A `domain/entities/` file exports a second class or any function',
  },
  {
    fixture: 'domain-projects-exports-classes-types-constants-and-type-guards',
    expected: [],
    qualityRow: '`domain/` exports only classes, types, constants and type guards',
  },
  {
    fixture: 'domain-projects-private-and-test-functions-are-not-checked',
    expected: [],
    qualityRow: '`domain/` exports only classes, types, constants and type guards',
  },
  {
    fixture: 'domain-projects-exports-loose-function',
    expected: ['api-domain-exports-no-function-but-type-guards'],
    qualityRow: '`domain/` exports a function other than a type guard',
  },
  {
    fixture: 'domain-projects-exports-arrow-function',
    expected: ['api-domain-exports-no-function-but-type-guards'],
    qualityRow: '`domain/` exports a function other than a type guard',
  },
  {
    fixture: 'domain-projects-exports-function-in-a-list',
    expected: ['api-domain-exports-no-function-but-type-guards'],
    qualityRow: '`domain/` exports a function other than a type guard',
  },
  {
    fixture: 'domain-executions-loose-function-is-not-checked-yet',
    expected: [],
    qualityRow: '`domain/` exports only classes, types, constants and type guards',
  },
]);
