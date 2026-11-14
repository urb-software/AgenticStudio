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
    expected: ['api-features-no-concrete-adapters', 'api-features-no-reachable-adapters'],
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
    expected: ['api-features-no-concrete-adapters', 'api-features-no-reachable-adapters'],
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
]);
