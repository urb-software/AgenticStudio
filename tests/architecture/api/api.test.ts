import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeGate } from '../suite';
import { directionViolations } from './direction-rules';
import { fileViolations } from './file-rules';
import { apiGate } from './gate';

const ROW_NEW_MODULE =
  'A structure rule is broken in a module the app does not have (`billing`)' as const;
const ROW_PORT_ANY_ROUTE =
  'An entry point imports a repository interface or port file by any route (nested, side-effect, dynamic, re-exported by a handler)' as const;
const ROW_ERROR_THROUGH_HANDLER =
  'An entry point imports an error class through a handler, or a test imports a fake from `ports/__tests__/`' as const;
const ROW_HANDLER_FAIL =
  'A handler returns an entity class, does not export its result type, or has a public method with no declared return type' as const;

const ROW_DATA_FAIL =
  'A handler, port, collaborator, entry point, repository interface or `contracts/` file imports a `*-data.ts` file' as const;
const ROW_DATA_OWN_ENTITY_FAIL =
  'A `*-data.ts` file is imported by a file of `domain/entities/` other than its own entity (a facts file or another entity)' as const;
const ROW_DATA_OTHER_MODULE_FAIL =
  'A repository adapter imports the `*-data.ts` file of another module' as const;
const ROW_REPOSITORY_RETURNS_FAIL =
  'A repository interface returns an `…Data` type, a facts type, or a value object its entity does not hold as a readonly field' as const;
const ROW_SNAPSHOT_METHOD_FAIL =
  'A class under `domain/` declares `snapshot` or `toSnapshot`' as const;
const ROW_PROTOCOL_FAIL =
  'A file under `application/` imports the worker protocol package or an entry point' as const;
const ROW_INPUT_FAIL =
  'A handler input refers to a class from `domain/`, directly or by extending it' as const;

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
  { fixture: 'file-cycle', expected: ['api-no-circular', 'api-domain-has-no-import-cycles'] },
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
  {
    fixture: 'domain-imports-file-system',
    expected: ['api-domain-independent', 'api-domain-no-runtime-modules'],
  },
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
  { fixture: 'secrets-used-through-entry-points', expected: [] },
  { fixture: 'module-imports-secrets-internals', expected: ['api-secrets-via-entry-points'] },
  {
    fixture: 'secrets-module-imported-outside-module-file',
    expected: ['api-secrets-module-in-module-files'],
  },
  { fixture: 'module-uses-secret-model', expected: ['api-secret-model-in-secrets-only'] },
  { fixture: 'module-reads-secrets-key', expected: ['api-secrets-key-reads'] },
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
  { fixture: 'module-uses-other-module-public-contract', expected: [] },
  {
    fixture: 'module-imports-other-module-http-contract',
    expected: ['api-contracts-only-index-and-events', 'api-cross-module-contracts-index-only'],
  },
  {
    fixture: 'module-imports-other-module-http-shared',
    expected: ['api-no-cross-module-private'],
  },
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
    expected: [
      'api-entities-are-classes-with-non-public-constructors',
      'api-entity-file-exports-one-class-and-no-function',
    ],
    qualityRow: '`domain/entities/` file exports a class with a public constructor, or no class',
  },
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
    fixture: 'value-object-class-owns-its-limit-input-and-error',
    expected: [],
    qualityRow:
      'A `domain/value-objects/` file exports one class or one record, with the lists and guards that describe it',
  },
  {
    fixture: 'value-object-exports-constant-without-a-class',
    expected: ['api-value-object-constant-needs-a-class'],
    qualityRow:
      'A `domain/value-objects/` file exports a constant that is not a list of allowed values and no class',
  },
  {
    fixture: 'value-object-class-and-unrelated-record',
    expected: ['api-value-object-file-is-one-concept'],
    qualityRow:
      'A `domain/value-objects/` file exports two classes, two records, or a record not named after its class',
  },
  {
    fixture: 'value-object-two-classes',
    expected: ['api-value-object-file-is-one-concept'],
    qualityRow:
      'A `domain/value-objects/` file exports two classes, two records, or a record not named after its class',
  },
  {
    fixture: 'value-object-two-records',
    expected: ['api-value-object-file-is-one-concept'],
    qualityRow:
      'A `domain/value-objects/` file exports two classes, two records, or a record not named after its class',
  },
  {
    fixture: 'value-object-constant-beside-a-class',
    expected: [],
    qualityRow:
      'A `domain/value-objects/` file exports a constant that is not a list beside a class',
  },
  {
    fixture: 'domain-has-no-factories-directory',
    expected: [],
    qualityRow:
      'A module has no `factories` directory under `domain/` or `application/` (tests are not checked)',
  },
  {
    fixture: 'domain-test-factories-directory-is-not-checked',
    expected: [],
    qualityRow:
      'A module has no `factories` directory under `domain/` or `application/` (tests are not checked)',
  },
  {
    fixture: 'domain-has-factories-directory',
    expected: ['api-domain-no-factories-directory'],
    qualityRow: 'A module has a `factories` directory under `domain/` or `application/`',
  },
  {
    fixture: 'application-has-factories-directory',
    expected: ['api-domain-no-factories-directory'],
    qualityRow: 'A module has a `factories` directory under `domain/` or `application/`',
  },
  {
    fixture: 'domain-class-of-methods-returning-another-class',
    expected: [
      'api-domain-no-class-of-methods-returning-another-class',
      'api-domain-static-is-a-factory',
    ],
    qualityRow: 'A `domain/` class only has methods returning another class',
  },
  {
    fixture: 'domain-class-with-state-and-a-method-returning-another-class',
    expected: [],
    qualityRow: 'A `domain/` class has state, or methods returning its own class',
  },
  {
    fixture: 'domain-static-methods-return-their-class',
    expected: [],
    qualityRow: 'A public static method of an entity or value object returns its own class',
  },
  {
    fixture: 'domain-static-in-class-expression',
    expected: ['api-domain-static-is-a-factory'],
    qualityRow:
      'A public static method of an entity or value object returns something else, or declares no return type',
  },
  {
    fixture: 'domain-imports-bare-module',
    expected: ['api-domain-no-runtime-modules'],
    qualityRow: '`domain/` imports `node:crypto`, `fs`, `dns`, `timers` or another runtime module',
  },
  {
    fixture: 'domain-imports-node-module',
    expected: ['api-domain-no-runtime-modules'],
    qualityRow: '`domain/` imports `node:crypto`, `fs`, `dns`, `timers` or another runtime module',
  },
  {
    fixture: 'domain-static-method-returns-another-type',
    expected: ['api-domain-static-is-a-factory'],
    qualityRow:
      'A public static method of an entity or value object returns something else, or declares no return type',
  },
  {
    fixture: 'domain-static-method-without-return-type',
    expected: ['api-domain-static-is-a-factory'],
    qualityRow:
      'A public static method of an entity or value object returns something else, or declares no return type',
  },
  {
    fixture: 'domain-static-accessor',
    expected: ['api-domain-static-is-a-factory'],
    qualityRow:
      'A public static method of an entity or value object returns something else, or declares no return type',
  },
  {
    fixture: 'domain-unexported-class-with-static-rule',
    expected: ['api-domain-static-is-a-factory'],
    qualityRow:
      'A public static method of an entity or value object returns something else, or declares no return type',
  },
  {
    fixture: 'domain-static-function-property',
    expected: ['api-domain-static-is-a-factory'],
    qualityRow:
      'A public static method of an entity or value object returns something else, or declares no return type',
  },
  {
    fixture: 'domain-short-helper-without-domain-types',
    expected: [],
    qualityRow:
      'A `domain/` top-level function is an exported type guard, or a short unexported helper without domain types',
  },
  {
    fixture: 'domain-long-helper',
    expected: ['api-domain-top-level-function-is-a-guard-or-helper'],
    qualityRow: 'A `domain/` unexported function is over ten lines or names a domain type',
  },
  {
    fixture: 'domain-helper-names-a-domain-type',
    expected: ['api-domain-top-level-function-is-a-guard-or-helper'],
    qualityRow: 'A `domain/` unexported function is over ten lines or names a domain type',
  },
  {
    fixture: 'domain-error-class-without-members',
    expected: [],
    qualityRow: 'A `domain/` class has an instance member, or is an error class',
  },
  {
    fixture: 'domain-class-with-only-statics',
    expected: ['api-domain-class-has-instance-member'],
    qualityRow: 'A `domain/` class has no instance member',
  },
  {
    fixture: 'domain-test-imports-node-crypto',
    expected: [],
    qualityRow: '`domain/` imports no runtime module (tests are not checked)',
  },
  {
    fixture: 'domain-hashes-with-create-hash',
    expected: [],
    qualityRow: '`domain/` imports no runtime module (tests are not checked)',
  },
  {
    fixture: 'domain-imports-random-bytes-from-crypto',
    expected: ['api-domain-no-runtime-modules'],
    qualityRow: '`domain/` imports `node:crypto`, `fs`, `dns`, `timers` or another runtime module',
  },
  {
    fixture: 'domain-imports-crypto-namespace',
    expected: ['api-domain-no-runtime-modules'],
    qualityRow: '`domain/` imports `node:crypto`, `fs`, `dns`, `timers` or another runtime module',
  },
  {
    fixture: 'domain-imports-node-crypto',
    expected: ['api-domain-no-runtime-modules'],
    qualityRow: '`domain/` imports `node:crypto`, `fs`, `dns`, `timers` or another runtime module',
  },
  {
    fixture: 'domain-imports-bare-dns',
    expected: ['api-domain-no-runtime-modules'],
    qualityRow: '`domain/` imports `node:crypto`, `fs`, `dns`, `timers` or another runtime module',
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
    fixture: 'handler-returns-view-and-exports-input-and-result',
    expected: [],
    qualityRow:
      'A handler returns ids, values or a view type of its own, and exports its input and result types',
  },
  {
    fixture: 'handler-returns-entity-class',
    expected: ['api-handlers-return-plain-data'],
    qualityRow: ROW_HANDLER_FAIL,
  },
  {
    fixture: 'handler-result-wraps-entity-class',
    expected: ['api-handlers-return-plain-data'],
    qualityRow: ROW_HANDLER_FAIL,
  },
  {
    fixture: 'handler-does-not-export-result-type',
    expected: ['api-handlers-return-plain-data'],
    qualityRow: ROW_HANDLER_FAIL,
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
    fixture: 'repository-returns-own-data',
    expected: ['api-data-between-entity-and-repository', 'api-repository-refers-to-one-entity'],
    qualityRow: ROW_REPOSITORY_RETURNS_FAIL,
  },
  {
    fixture: 'executions-repository-returns-root-child-data',
    expected: ['api-data-between-entity-and-repository', 'api-repository-refers-to-one-entity'],
    qualityRow: ROW_REPOSITORY_RETURNS_FAIL,
  },
  {
    fixture: 'repository-returns-other-roots-data',
    expected: ['api-data-between-entity-and-repository', 'api-repository-refers-to-one-entity'],
    qualityRow: ROW_REPOSITORY_RETURNS_FAIL,
  },
  {
    fixture: 'repository-returns-value-object-its-entity-only-imports',
    expected: ['api-repository-refers-to-one-entity'],
    qualityRow: ROW_REPOSITORY_RETURNS_FAIL,
  },
  {
    fixture: 'repository-returns-own-aggregate-value-object',
    expected: [],
    qualityRow:
      'A repository interface returns its entity, its pinned child entity, or a value object its entity holds as a readonly field',
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
  },
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
    fixture: 'entity-executions-one-class-and-nothing-else',
    expected: [],
    qualityRow: 'A `domain/entities/` file exports exactly one class and no function',
  },
  {
    fixture: 'entity-executions-class-and-error-class',
    expected: ['api-entity-file-exports-one-class-and-no-function'],
    qualityRow: 'A `domain/entities/` file exports a second class or any function',
  },
  {
    fixture: 'entity-executions-class-and-function',
    expected: [
      'api-entity-file-exports-one-class-and-no-function',
      'api-domain-exports-no-function-but-type-guards',
    ],
    qualityRow: 'A `domain/entities/` file exports a second class or any function',
  },
  {
    fixture: 'domain-executions-exports-classes-types-constants-and-type-guards',
    expected: [],
    qualityRow: '`domain/` exports only classes, types, constants and type guards',
  },
  {
    fixture: 'domain-executions-exports-loose-function',
    expected: ['api-domain-exports-no-function-but-type-guards'],
    qualityRow: '`domain/` exports a function other than a type guard',
  },
  // An entry point takes an error from the root's errors file, a type from the entity file.
  {
    fixture: 'executions-entry-point-imports-type-from-entities-and-error-from-errors-file',
    expected: [],
    qualityRow: '`entry-points/` imports an error class from an errors file in `domain/errors/`',
  },
  {
    fixture: 'executions-entry-point-imports-entity-class',
    expected: ['api-entry-points-no-entity-classes'],
  },
  {
    fixture: 'executions-handler-returns-entity-class',
    expected: ['api-handlers-return-plain-data'],
  },
  {
    fixture: 'executions-repository-refers-to-root-and-its-child',
    expected: [],
  },
  {
    fixture: 'executions-repository-refers-to-two-entities',
    expected: ['api-repository-refers-to-one-entity'],
  },
  {
    fixture: 'executions-entity-imports-another-entity',
    expected: ['api-entities-do-not-import-entities'],
  },
  {
    fixture: 'executions-entity-imports-run-step-from-another-root',
    expected: ['api-entities-do-not-import-entities'],
  },
  {
    fixture: 'executions-repository-refers-to-another-root-and-the-run-step',
    expected: ['api-repository-refers-to-one-entity'],
  },
  {
    fixture: 'billing-feature-imports-another-feature',
    expected: ['api-features-no-feature-imports'],
    qualityRow: ROW_NEW_MODULE,
  },
  {
    fixture: 'billing-entity-class-with-private-constructor',
    expected: [],
    qualityRow: '`domain/entities/` file exports a class with a non-public constructor',
  },
  {
    fixture: 'billing-entity-class-with-public-constructor',
    expected: ['api-entities-are-classes-with-non-public-constructors'],
    qualityRow: ROW_NEW_MODULE,
  },
  {
    fixture: 'billing-entry-point-imports-entity-class',
    expected: ['api-entry-points-no-entity-classes'],
    qualityRow: ROW_NEW_MODULE,
  },
  {
    fixture: 'billing-handler-returns-entity-class',
    expected: ['api-handlers-return-plain-data'],
    qualityRow: ROW_NEW_MODULE,
  },
  {
    fixture: 'billing-repository-refers-to-two-entities',
    expected: ['api-repository-refers-to-one-entity'],
    qualityRow: ROW_NEW_MODULE,
  },
  {
    fixture: 'billing-entity-imports-another-entity',
    expected: ['api-entities-do-not-import-entities'],
    qualityRow: ROW_NEW_MODULE,
  },
  {
    fixture: 'billing-entity-class-and-function',
    expected: [
      'api-entity-file-exports-one-class-and-no-function',
      'api-domain-exports-no-function-but-type-guards',
    ],
    qualityRow: ROW_NEW_MODULE,
  },
  {
    fixture: 'billing-domain-exports-loose-function',
    expected: ['api-domain-exports-no-function-but-type-guards'],
    qualityRow: ROW_NEW_MODULE,
  },
  {
    fixture: 'application-collaborator-imports-ports-and-domain',
    expected: [],
    qualityRow: 'An application collaborator imports ports and the domain',
  },
  {
    fixture: 'application-collaborator-imports-a-feature',
    expected: ['api-collaborators-no-feature-imports'],
    qualityRow: 'An application collaborator imports `application/features/`',
  },
  {
    fixture: 'feature-imports-another-feature-side-effect',
    expected: ['api-features-no-feature-imports'],
    qualityRow: 'A feature imports another feature of its module',
  },
  {
    fixture: 'feature-imports-another-feature-dynamically',
    expected: ['api-features-no-feature-imports'],
    qualityRow: 'A feature imports another feature of its module',
  },
  {
    fixture: 'entry-point-imports-port-file-by-side-effect',
    expected: ['api-entry-points-no-ports-or-infrastructure'],
    qualityRow: ROW_PORT_ANY_ROUTE,
  },
  {
    fixture: 'entry-point-imports-port-file-dynamically',
    expected: ['api-entry-points-no-ports-or-infrastructure'],
    qualityRow: ROW_PORT_ANY_ROUTE,
  },
  {
    fixture: 'entry-point-imports-nested-port-file',
    expected: ['api-entry-points-no-ports-or-infrastructure'],
    qualityRow: ROW_PORT_ANY_ROUTE,
  },
  {
    fixture: 'entry-point-imports-port-token-through-handler',
    expected: ['api-entry-points-no-ports-or-infrastructure'],
    qualityRow: ROW_PORT_ANY_ROUTE,
  },
  {
    fixture: 'entry-point-imports-port-token-through-handler-export-star',
    expected: ['api-entry-points-no-ports-or-infrastructure'],
    qualityRow: ROW_PORT_ANY_ROUTE,
  },
  {
    fixture: 'entry-point-imports-error-class-through-handler',
    expected: [],
    qualityRow: ROW_ERROR_THROUGH_HANDLER,
  },
  {
    fixture: 'entry-point-test-imports-port-test-fake',
    expected: [],
    qualityRow: ROW_ERROR_THROUGH_HANDLER,
  },
  {
    fixture: 'handler-method-without-return-type',
    expected: ['api-handlers-return-plain-data'],
    qualityRow: ROW_HANDLER_FAIL,
  },
  {
    fixture: 'handler-returns-entity-class-through-namespace-import',
    expected: ['api-handlers-return-plain-data'],
    qualityRow: ROW_HANDLER_FAIL,
  },
  {
    fixture: 'repository-property-returns-value-object',
    expected: ['api-repository-refers-to-one-entity'],
    qualityRow: ROW_REPOSITORY_RETURNS_FAIL,
  },
  {
    fixture: 'repository-returns-value-object-through-namespace-import',
    expected: ['api-repository-refers-to-one-entity'],
    qualityRow: ROW_REPOSITORY_RETURNS_FAIL,
  },
  {
    fixture: 'domain-exports-arrow-function-with-satisfies',
    expected: ['api-domain-exports-no-function-but-type-guards'],
    qualityRow: '`domain/` exports a function other than a type guard',
  },
  {
    fixture: 'domain-exports-overloaded-function',
    expected: ['api-domain-exports-no-function-but-type-guards'],
    qualityRow: '`domain/` exports a function other than a type guard',
  },
  {
    fixture: 'domain-exports-overloaded-type-guard',
    expected: [],
    qualityRow: '`domain/` exports only classes, types, constants and type guards',
  },
  {
    fixture: 'entity-class-expression-with-private-constructor',
    expected: [],
    qualityRow: '`domain/entities/` file exports a class with a non-public constructor',
  },
  {
    fixture: 'entity-class-and-class-expression',
    expected: ['api-entity-file-exports-one-class-and-no-function'],
    qualityRow: 'A `domain/entities/` file exports a second class or any function',
  },
  {
    fixture: 'domain-leaves-import-smaller-leaves-and-entities-import-leaves',
    expected: [],
    qualityRow:
      'Nothing under `domain/value-objects/` or `domain/errors/` imports from `domain/entities/`',
  },
  {
    fixture: 'domain-value-object-imports-entity',
    expected: ['api-domain-leaves-do-not-import-entities'],
    qualityRow:
      'A file under `domain/value-objects/` or `domain/errors/` imports (or re-exports from) `domain/entities/`',
  },
  {
    fixture: 'domain-error-imports-entity',
    expected: ['api-domain-leaves-do-not-import-entities'],
    qualityRow:
      'A file under `domain/value-objects/` or `domain/errors/` imports (or re-exports from) `domain/entities/`',
  },
  {
    fixture: 'domain-value-object-re-exports-from-entity-file',
    expected: ['api-domain-leaves-do-not-import-entities'],
    qualityRow:
      'A file under `domain/value-objects/` or `domain/errors/` imports (or re-exports from) `domain/entities/`',
  },
  {
    fixture: 'domain-imports-form-a-diamond-without-a-cycle',
    expected: [],
    qualityRow: "A module's `domain/` has no import cycle",
  },
  {
    fixture: 'domain-type-only-import-cycle',
    expected: ['api-domain-has-no-import-cycles', 'api-no-circular'],
    qualityRow:
      "A module's `domain/` has an import cycle, type-only imports and `export … from` included",
  },
  {
    fixture: 'domain-import-cycle-through-export-from',
    expected: ['api-domain-has-no-import-cycles', 'api-no-circular'],
    qualityRow:
      "A module's `domain/` has an import cycle, type-only imports and `export … from` included",
  },
  {
    fixture: 'domain-cycle-in-a-test-is-not-checked',
    expected: ['api-no-circular'],
  },
  {
    fixture: 'entity-companions-export-types-only',
    expected: [],
    qualityRow: 'A type-only companion of an entity (`-data`, `-facts`) exports types only',
  },
  {
    fixture: 'entity-companion-exports-class',
    expected: ['api-entity-companions-export-types-only'],
    qualityRow: 'A companion file exports a class, a function, a value or `export *`',
  },
  {
    fixture: 'entity-companion-exports-function',
    expected: [
      'api-entity-companions-export-types-only',
      'api-domain-exports-no-function-but-type-guards',
    ],
    qualityRow: 'A companion file exports a class, a function, a value or `export *`',
  },
  {
    fixture: 'entity-companion-exports-value-and-star',
    expected: ['api-entity-companions-export-types-only'],
    qualityRow: 'A companion file exports a class, a function, a value or `export *`',
  },
  {
    fixture: 'entity-file-without-companion-suffix-keeps-the-entity-checks',
    expected: ['api-entities-are-classes-with-non-public-constructors'],
    qualityRow: '`domain/entities/` file exports a class with a public constructor, or no class',
  },
  {
    fixture: 'repository-returns-companion-facts',
    expected: ['api-data-between-entity-and-repository', 'api-repository-refers-to-one-entity'],
    qualityRow:
      'A repository interface refers to two entity files, or its main type is under `domain/value-objects/`',
  },
  {
    fixture: 'billing-repository-imports-its-data',
    expected: [],
    qualityRow:
      'A `*-data.ts` file is imported only by its own entity and by `infrastructure/repositories/` of the same module',
  },
  {
    fixture: 'billing-handler-imports-data',
    expected: ['api-data-between-entity-and-repository'],
    qualityRow: ROW_DATA_FAIL,
  },
  {
    fixture: 'billing-entry-point-imports-data',
    expected: ['api-data-between-entity-and-repository'],
    qualityRow: ROW_DATA_FAIL,
  },
  {
    fixture: 'billing-contracts-imports-data',
    expected: ['api-data-between-entity-and-repository', 'api-contracts-self-contained'],
    qualityRow: ROW_DATA_FAIL,
  },
  {
    fixture: 'billing-facts-file-indexes-entity-data',
    expected: ['api-data-only-for-its-own-entity'],
    qualityRow: ROW_DATA_OWN_ENTITY_FAIL,
  },
  {
    fixture: 'billing-entity-imports-another-entity-data',
    expected: ['api-data-only-for-its-own-entity'],
    qualityRow: ROW_DATA_OWN_ENTITY_FAIL,
  },
  {
    fixture: 'shipping-repository-imports-billing-data',
    expected: ['api-data-only-for-repositories-of-its-module', 'api-no-cross-module-private'],
    qualityRow: ROW_DATA_OTHER_MODULE_FAIL,
  },
  {
    fixture: 'billing-handler-named-like-a-test-file-imports-data',
    expected: ['api-data-between-entity-and-repository'],
    qualityRow: ROW_DATA_FAIL,
  },
  {
    fixture: 'billing-entity-named-like-a-test-file-imports-other-data',
    expected: ['api-data-only-for-its-own-entity'],
    qualityRow: ROW_DATA_OWN_ENTITY_FAIL,
  },
  {
    fixture: 'shipping-repository-named-like-a-test-file-imports-billing-data',
    expected: ['api-data-only-for-repositories-of-its-module', 'api-no-cross-module-private'],
    qualityRow: ROW_DATA_OTHER_MODULE_FAIL,
  },
  {
    fixture: 'entity-declares-snapshot',
    expected: ['api-domain-no-snapshot-method'],
    qualityRow: ROW_SNAPSHOT_METHOD_FAIL,
  },
  {
    fixture: 'value-object-declares-to-snapshot',
    expected: ['api-domain-no-snapshot-method'],
    qualityRow: ROW_SNAPSHOT_METHOD_FAIL,
  },
  {
    fixture: 'entity-and-value-object-use-restore-and-to-data',
    expected: [],
    qualityRow: 'An entity restores from its data and a value object offers `restore` and `toData`',
  },
  {
    fixture: 'entity-companion-snapshot-suffix',
    expected: ['api-entities-are-classes-with-non-public-constructors'],
    qualityRow:
      'A `-snapshot.ts` file in `domain/entities/` (only `-data.ts` and `-facts.ts` are companions)',
  },
  {
    fixture: 'billing-handler-imports-worker-protocol',
    expected: ['api-application-no-worker-protocol-or-entry-points', 'api-local-imports-resolve'],
    qualityRow: ROW_PROTOCOL_FAIL,
  },
  {
    fixture: 'billing-handler-imports-entry-point',
    expected: ['api-application-no-worker-protocol-or-entry-points'],
    qualityRow: ROW_PROTOCOL_FAIL,
  },
  {
    fixture: 'billing-handler-test-imports-entry-point',
    expected: [],
    qualityRow: 'A test under `application/` imports an entry point (tests are not checked)',
  },
  {
    fixture: 'billing-handler-input-plain-data',
    expected: [],
    qualityRow:
      'A handler input holds plain data: primitives, lists of allowed values and nested shapes it declares',
  },
  {
    fixture: 'billing-handler-input-holds-domain-class',
    expected: ['api-handler-input-plain-data'],
    qualityRow: ROW_INPUT_FAIL,
  },
  {
    fixture: 'billing-handler-input-imports-class-with-alias',
    expected: ['api-handler-input-plain-data'],
    qualityRow: ROW_INPUT_FAIL,
  },
  {
    fixture: 'billing-handler-input-intersection-at-parameter',
    expected: ['api-handler-input-plain-data'],
    qualityRow: ROW_INPUT_FAIL,
  },
  {
    fixture: 'billing-handler-input-extends-domain-class',
    expected: ['api-handler-input-plain-data'],
    qualityRow: ROW_INPUT_FAIL,
  },
  {
    fixture: 'reference-module',
    expected: [],
    qualityRow: 'The reference module fixture (the complete approved layout)',
  },
]);

describe('architecture:api precision', () => {
  const fixtures = join(import.meta.dirname, '..', 'fixtures', 'api');

  it('an overloaded function is one export, reported once', () => {
    expect(fileViolations(join(fixtures, 'domain-exports-overloaded-function'))).toEqual([
      {
        rule: 'api-domain-exports-no-function-but-type-guards',
        from: 'src/modules/billing/domain/value-objects/rounding.ts',
        to: 'exports the function round',
      },
    ]);
  });

  it('the direction checks ignore the files of __tests__/', () => {
    expect(directionViolations(join(fixtures, 'domain-cycle-in-a-test-is-not-checked'))).toEqual(
      [],
    );
  });

  it('an overloaded type guard is not reported', () => {
    expect(fileViolations(join(fixtures, 'domain-exports-overloaded-type-guard'))).toEqual([]);
  });
});
