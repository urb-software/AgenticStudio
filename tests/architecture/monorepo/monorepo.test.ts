import { describeGate } from '../suite';
import { monorepoGate } from './gate';

describeGate('monorepo', monorepoGate, '.', [
  { fixture: 'apps-use-packages', expected: [] },
  { fixture: 'web-imports-api-implementation', expected: ['mono-no-cross-app-imports'] },
  { fixture: 'web-imports-database-package', expected: ['mono-web-no-server-implementations'] },
  {
    fixture: 'web-manifest-depends-on-database',
    expected: ['mono-manifest-web-no-server-packages'],
  },
  { fixture: 'package-imports-app', expected: ['mono-packages-no-apps'] },
  { fixture: 'privileged-app-imports-another-app', expected: ['mono-no-cross-app-imports'] },
  { fixture: 'app-manifest-depends-on-app', expected: ['mono-manifest-no-app-dependencies'] },
  {
    fixture: 'packages-cycle',
    expected: ['mono-no-workspace-cycle', 'mono-manifest-no-package-cycles'],
  },
  { fixture: 'file-cycle', expected: ['mono-no-circular'] },
  { fixture: 'unresolved-workspace-import', expected: ['mono-workspace-imports-resolve'] },
  {
    fixture: 'app-imports-package-by-relative-path',
    expected: ['mono-no-relative-imports-into-packages'],
  },
]);
