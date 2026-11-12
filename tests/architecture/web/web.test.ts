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
  {
    fixture: 'app-deep-imports-module-internals',
    expected: ['web-app-imports-public-entrypoints-only'],
  },
  { fixture: 'shared-imports-module', expected: ['web-shared-no-business-modules'] },
  { fixture: 'platform-imports-module', expected: ['web-platform-no-business-modules'] },
  { fixture: 'imports-server-code', expected: ['web-no-server-code'] },
  { fixture: 'imports-node-only-module', expected: ['web-no-server-code'] },
  { fixture: 'modules-cycle-through-entrypoints', expected: ['web-no-module-cycle'] },
  { fixture: 'file-cycle', expected: ['web-no-circular'] },
]);
