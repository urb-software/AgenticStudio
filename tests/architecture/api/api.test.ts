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
    expected: ['api-no-cross-module-private', 'api-features-no-concrete-adapters'],
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
    expected: ['api-features-no-concrete-adapters'],
  },
  { fixture: 'handler-imports-database-client', expected: ['api-features-no-concrete-adapters'] },
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
  { fixture: 'handler-imports-queue-client', expected: ['api-features-no-concrete-adapters'] },
  { fixture: 'domain-imports-docker-client', expected: ['api-domain-independent'] },
  { fixture: 'unresolved-relative-import', expected: ['api-local-imports-resolve'] },
  { fixture: 'handler-imports-adapter-via-port', expected: ['api-ports-independent'] },
  { fixture: 'contracts-reexport-infrastructure', expected: ['api-contracts-self-contained'] },
  { fixture: 'contracts-import-domain', expected: ['api-contracts-self-contained'] },
  { fixture: 'domain-imports-file-system', expected: ['api-domain-independent'] },
  { fixture: 'module-root-file-reexports-adapter', expected: ['api-module-layout'] },
  { fixture: 'undocumented-folder-reexports-adapter', expected: ['api-module-layout'] },
  {
    fixture: 'handler-imports-module-file',
    expected: ['api-module-file-composition-root-only'],
  },
  { fixture: 'port-reexports-database-client', expected: ['api-ports-independent'] },
]);
