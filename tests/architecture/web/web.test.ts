import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listDirectories } from '../harness';
import { describeGate, REPO_ROOT } from '../suite';
import { webGate } from './gate';
import { designSystemImportViolations } from './styling-rules';

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
  { fixture: 'styling-uses-tokens', expected: [] },
  { fixture: 'module-imports-design-system', expected: ['web-no-design-system-imports'] },
  { fixture: 'css-imports-design-system', expected: ['web-no-design-system-imports'] },
  { fixture: 'alias-to-design-system', expected: ['web-no-design-system-imports'] },
  { fixture: 'next-config-aliases-design-system', expected: ['web-no-design-system-imports'] },
  { fixture: 'colour-literal-in-class-name', expected: ['web-no-colour-literals'] },
  { fixture: 'colour-function-in-css', expected: ['web-no-colour-literals'] },
  { fixture: 'colour-literal-in-scss', expected: ['web-no-colour-literals'] },
  { fixture: 'style-prop-carries-colour', expected: ['web-no-style-colours'] },
  { fixture: 'style-prop-colour-in-value', expected: ['web-no-style-colours'] },
]);

// The design-system import ban covers every app, not only apps/web (frontend.md, "Styling and
// UI components"); the gate above proves the rule on fixtures, this applies it to apps/*.
describe('architecture:web design-system imports in apps/*', () => {
  const apps = listDirectories(REPO_ROOT, 'apps');

  it('finds the apps', () => {
    expect(apps).toContain('web');
  });

  it.each(apps)('apps/%s does not import design-system/', (app) => {
    expect(designSystemImportViolations(join(REPO_ROOT, 'apps', app))).toEqual([]);
  });
});
