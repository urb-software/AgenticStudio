import { describeGate } from '../suite';
import { webGate } from './gate';

describeGate('web', webGate, 'apps/web', [
  {
    fixture: 'app-imports-module-public-entrypoint',
    expected: [],
    qualityRow: 'Web imports `@/modules/agents` public entrypoint',
  },
  {
    fixture: 'module-deep-imports-private-store',
    expected: ['web-cross-module-public-entrypoints-only'],
    qualityRow: "Web deep-imports another module's private Zustand store",
  },
  { fixture: 'modules-and-app-import-platform', expected: [] },
  { fixture: 'generated-client-internal-cycle', expected: [] },
  {
    fixture: 'app-deep-imports-module-internals',
    expected: ['web-app-imports-public-entrypoints-only'],
  },
  { fixture: 'shared-imports-module', expected: ['web-shared-no-upward-imports'] },
  { fixture: 'shared-imports-platform', expected: ['web-shared-no-upward-imports'] },
  { fixture: 'module-imports-app', expected: ['web-modules-no-app'] },
  { fixture: 'unresolved-alias-import', expected: ['web-local-imports-resolve'] },
  { fixture: 'unresolved-workspace-import', expected: ['web-local-imports-resolve'] },
  { fixture: 'platform-imports-module', expected: ['web-platform-no-business-modules'] },
  { fixture: 'imports-server-code', expected: ['web-no-server-code'] },
  { fixture: 'imports-node-only-module', expected: ['web-no-server-code'] },
  { fixture: 'modules-cycle-through-entrypoints', expected: ['web-no-module-cycle'] },
  { fixture: 'file-cycle', expected: ['web-no-circular'] },
  {
    fixture: 'generated-client-imports-server-code',
    expected: ['web-no-server-code', 'web-platform-no-business-modules'],
  },
  {
    fixture: 'module-imports-generated-client',
    expected: ['web-generated-client-only-via-platform-api'],
  },
  {
    fixture: 'database-package-unresolved-import',
    expected: ['web-no-server-code', 'web-database-package-imports-resolve'],
  },
]);
