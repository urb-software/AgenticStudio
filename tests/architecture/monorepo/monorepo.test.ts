import { describe, expect, it } from 'vitest';
import { SERVER_PACKAGES, workspacePackages } from '../harness';
import { describeGate, REPO_ROOT } from '../suite';
import { monorepoGate, WEB_PACKAGE_CLASSIFICATION } from './gate';

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

describe('architecture:monorepo web package classification', () => {
  const { allowed, forbidden } = WEB_PACKAGE_CLASSIFICATION;

  it('every packages/* workspace package is classified as web-allowed or web-forbidden', () => {
    const unclassified = workspacePackages(REPO_ROOT)
      .filter((pkg) => pkg.dir.startsWith('packages/'))
      .map((pkg) => pkg.name)
      .filter((name) => allowed.includes(name) === forbidden.includes(name));
    expect(unclassified).toEqual([]);
  });

  it('every web-forbidden package is enforced by the server package rules', () => {
    expect(forbidden.filter((name) => !SERVER_PACKAGES.includes(name))).toEqual([]);
  });
});
