import {
  coreModules,
  npmPackages,
  SERVER_PACKAGES,
  importsResolveRules,
  WORKSPACE_PACKAGES_FROM_SOURCE,
  type Gate,
} from '../harness';

const PUBLIC_ENTRYPOINT = '^src/modules/[^/]+/index\\.tsx?$';
const GENERATED_CLIENT = '^src/platform/api/generated/';

/**
 * `architecture:web`: the Next.js rules of docs/engineering/quality.md §4 and
 * docs/architecture/frontend.md §2–§3. Paths are relative to `apps/web`.
 * Dependency direction: app → modules → platform/shared; platform → shared.
 */
export const webGate: Gate = {
  entries: ['src'],
  // @agentic-studio/* imports resolve to packages/<name>/src, so the server-package rules
  // see them without a build.
  ...WORKSPACE_PACKAGES_FROM_SOURCE,
  forbidden: [
    {
      name: 'web-cross-module-public-entrypoints-only',
      comment:
        'A frontend module uses another module only through its public index.ts, never its private ' +
        'stores, hooks, services or editor internals.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/', pathNot: ['^src/modules/$1/', PUBLIC_ENTRYPOINT] },
    },
    {
      name: 'web-app-imports-public-entrypoints-only',
      comment: 'app/ composes feature APIs and never reaches into private feature files.',
      severity: 'error',
      from: { path: '^src/app/' },
      to: { path: '^src/modules/', pathNot: PUBLIC_ENTRYPOINT },
    },
    {
      name: 'web-modules-no-app',
      comment: 'Modules never depend on the app/ routes that compose them.',
      severity: 'error',
      from: { path: '^src/modules/' },
      to: { path: '^src/app/' },
    },
    {
      name: 'web-platform-no-business-modules',
      comment: 'platform/ (API client, auth, realtime, query) never depends on business modules.',
      severity: 'error',
      from: { path: '^src/platform/' },
      to: { path: '^src/(modules|app)/' },
    },
    {
      name: 'web-shared-no-upward-imports',
      comment: 'shared/ is the bottom layer: it never depends on modules/, app/ or platform/.',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/(modules|app|platform)/' },
    },
    {
      name: 'web-no-server-code',
      comment:
        'The web app never imports server implementations, ORM, secrets access, privileged process ' +
        'control or Node-only server modules. The gate cannot tell Client from Server Components, ' +
        'so only modules no web code needs are listed; fs or crypto use in client code is left to ' +
        'the build and review (quality.md §4).',
      severity: 'error',
      from: { path: '^src/' },
      to: {
        path: [
          npmPackages(...SERVER_PACKAGES),
          // Workspace packages resolve to their source (`../../packages/database/src/`).
          '(^|/)packages/(database|testing)/',
          coreModules('child_process', 'cluster', 'dgram', 'net', 'tls', 'worker_threads'),
        ],
      },
    },
    ...importsResolveRules('web', '^(\\.|@/|@agentic-studio/)'),
    {
      name: 'web-generated-client-only-via-platform-api',
      comment:
        'The generated API client is used only through src/platform/api (its public entry point), ' +
        'never imported directly from generated/.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/platform/api/' },
      to: { path: GENERATED_CLIENT },
    },
    {
      name: 'web-platform-auth-public-entrypoint-only',
      comment:
        'Operator login/logout/session UI lives in src/platform/auth; code outside it (app/, ' +
        'modules/, other platform/ areas) imports it only through src/platform/auth/index.ts. ' +
        'Kept specific to auth: platform/query has no index.ts, and app/(studio)/layout.tsx ' +
        'imports platform/query/query-provider directly.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/platform/auth/' },
      to: { path: '^src/platform/auth/', pathNot: '^src/platform/auth/index\\.tsx?$' },
    },
    {
      name: 'web-no-circular',
      comment:
        'No import cycles. Only the generated @hey-api client (checked by contracts:check) is ' +
        'exempt, for cycles between its own files; every other rule applies to it.',
      severity: 'error',
      from: { path: '^src/', pathNot: GENERATED_CLIENT },
      to: { circular: true },
    },
  ],
  unitCycles: { rule: 'web-no-module-cycle', unit: /^(src\/modules\/[^/]+)\// },
};
