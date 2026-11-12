import { coreModules, npmPackages, SERVER_PACKAGES, type Gate } from '../harness';

const PUBLIC_ENTRYPOINT = '^src/modules/[^/]+/index\\.tsx?$';
const GENERATED_CLIENT = '^src/platform/api/generated/';

/**
 * `architecture:web`: the Next.js rules of docs/engineering/quality.md §4 and
 * docs/architecture/frontend.md §2–§3. Paths are relative to `apps/web`.
 * Dependency direction: app → modules → platform/shared; platform → shared.
 */
export const webGate: Gate = {
  entries: ['src'],
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
          // A built workspace package resolves through its pnpm symlink to packages/<name>/dist/.
          '(^|/)packages/(database|testing)/',
          coreModules('child_process', 'cluster', 'dgram', 'net', 'tls', 'worker_threads'),
        ],
      },
    },
    {
      name: 'web-local-imports-resolve',
      comment: 'An unresolved relative or @/ import would silently drop an edge from the graph.',
      severity: 'error',
      from: {},
      to: { path: '^(\\.|@/)', couldNotResolve: true },
    },
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
