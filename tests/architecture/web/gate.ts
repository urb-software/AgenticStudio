import { coreModules, npmPackages, type Gate } from '../harness';

const PUBLIC_ENTRYPOINT = '^src/modules/[^/]+/index\\.tsx?$';

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
      name: 'web-shared-no-business-modules',
      comment:
        'shared/ never depends on business modules (or on the app/ routes that compose them).',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/(modules|app)/' },
    },
    {
      name: 'web-platform-no-business-modules',
      comment: 'platform/ (API client, auth, realtime, query) never depends on business modules.',
      severity: 'error',
      from: { path: '^src/platform/' },
      to: { path: '^src/(modules|app)/' },
    },
    {
      name: 'web-no-server-code',
      comment:
        'The web app never imports server implementations, ORM, secrets access, privileged process ' +
        'control or Node-only server modules.',
      severity: 'error',
      from: { path: '^src/' },
      to: {
        path: [
          npmPackages(
            '@agentic-studio/api',
            '@agentic-studio/database',
            '@agentic-studio/testing',
            '@nestjs',
            '@prisma',
            'prisma',
            'bullmq',
            'ioredis',
            'pg',
            'dockerode',
            'execa',
            'simple-git',
            'node-pty',
            'ssh2',
          ),
          coreModules('child_process', 'cluster', 'dgram', 'net', 'tls', 'worker_threads'),
        ],
      },
    },
    {
      name: 'web-no-circular',
      comment: 'No import cycles.',
      severity: 'error',
      from: { path: '^src/' },
      to: { circular: true },
    },
  ],
  unitCycles: { rule: 'web-no-module-cycle', unit: /^(src\/modules\/[^/]+)\// },
};
