import {
  coreModules,
  listDirectories,
  listFiles,
  npmPackages,
  type Gate,
  type Violation,
} from '../harness';

const MODULE_FILE = '^src/modules/([^/]+)/\\1\\.module\\.ts$';
const CONTRACTS = '^src/modules/[^/]+/contracts/';
const ORM = [
  npmPackages('@prisma', 'prisma', '@agentic-studio/database'),
  '(^|/)packages/database/',
];

/**
 * `architecture:api`: the NestJS rules of docs/engineering/quality.md §4 and
 * docs/architecture/backend.md §2–§3. Paths are relative to `apps/api`.
 */
export const apiGate: Gate = {
  entries: ['src'],
  forbidden: [
    {
      name: 'api-no-cross-module-private',
      comment:
        'A business module imports another business module only through its public contracts/.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/', pathNot: ['^src/modules/$1/', CONTRACTS] },
    },
    {
      name: 'api-outside-modules-imports-contracts-only',
      comment:
        'platform/ and shared/ must not reach into business modules except their public contracts/.',
      severity: 'error',
      from: { path: '^src/', pathNot: ['^src/modules/', '^src/app\\.module\\.ts$'] },
      to: { path: '^src/modules/', pathNot: CONTRACTS },
    },
    {
      name: 'api-composition-root-imports-module-files-only',
      comment:
        'Narrow DI wiring exception: the composition root (src/app.module.ts) may import a business ' +
        'module only through its {module}.module.ts or public contracts/.',
      severity: 'error',
      from: { path: '^src/app\\.module\\.ts$' },
      to: { path: '^src/modules/', pathNot: [MODULE_FILE, CONTRACTS] },
    },
    {
      name: 'api-domain-independent',
      comment:
        'domain/ never imports NestJS, ORM, database, queue, HTTP, process or infrastructure code.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/domain/' },
      to: {
        path: [
          npmPackages(
            '@nestjs',
            '@prisma',
            'prisma',
            '@agentic-studio/database',
            'bullmq',
            'ioredis',
            'redis',
            'pg',
            'express',
            'reflect-metadata',
          ),
          '(^|/)packages/database/',
          coreModules('http', 'https', 'http2', 'net', 'child_process'),
          '^src/platform/',
          '^src/modules/[^/]+/(features|consumers|infrastructure)/',
          MODULE_FILE,
        ],
      },
    },
    {
      name: 'api-features-no-concrete-adapters',
      comment:
        'Feature handlers and event consumers depend on domain repository contracts and ports, ' +
        'never on concrete repositories, adapters or the database client.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/(features|consumers)/' },
      to: { path: ['^src/modules/[^/]+/infrastructure/', '^src/platform/database/', ...ORM] },
    },
    {
      name: 'api-orm-only-in-infrastructure-repositories',
      comment:
        'Inside business modules, Prisma is used only by infrastructure/repositories/ adapters.',
      severity: 'error',
      from: { path: '^src/modules/', pathNot: '^src/modules/[^/]+/infrastructure/repositories/' },
      to: { path: ORM },
    },
    {
      name: 'api-no-circular',
      comment: 'No import cycles between files, layers or modules.',
      severity: 'error',
      from: { path: '^src/' },
      to: { circular: true },
    },
  ],
  unitCycles: { rule: 'api-no-module-cycle', unit: /^(src\/modules\/[^/]+)\// },
  structural: {
    rules: ['api-feature-has-handler', 'api-infrastructure-placement'],
    check: (baseDir) => [...featuresWithoutHandler(baseDir), ...misplacedInfrastructure(baseDir)],
  },
};

/** A present use-case feature has a handler.ts (endpoint.ts, schema.ts, input.ts are optional). */
function featuresWithoutHandler(baseDir: string): Violation[] {
  return listDirectories(baseDir, 'src/modules').flatMap((module) => {
    const features = `src/modules/${module}/features`;
    return listDirectories(baseDir, features)
      .map((feature) => `${features}/${feature}`)
      .filter((feature) => !listFiles(baseDir, feature).includes(`${feature}/handler.ts`))
      .map((feature) => ({ rule: 'api-feature-has-handler', from: feature }));
  });
}

/** Concrete repositories live in infrastructure/repositories/, adapters in infrastructure/adapters/. */
function misplacedInfrastructure(baseDir: string): Violation[] {
  return listDirectories(baseDir, 'src/modules').flatMap((module) => {
    const infrastructure = `src/modules/${module}/infrastructure/`;
    return listFiles(baseDir, infrastructure)
      .filter((file) => !/^(repositories|adapters)\//.test(file.slice(infrastructure.length)))
      .map((file) => ({ rule: 'api-infrastructure-placement', from: file }));
  });
}
