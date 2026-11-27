import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..');
const migrationsDir = path.join(packageRoot, 'prisma', 'migrations');

/**
 * Applies the committed migrations to the given database with `prisma migrate
 * deploy`, the same command as `pnpm db:migrate:deploy`. Intended for integration
 * tests against throwaway databases; never resets or pushes a schema.
 */
export async function deployMigrations(databaseUrl: string): Promise<void> {
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  await execFileAsync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

/**
 * Applies the committed migrations up to and including `lastMigration`, in a copy of the
 * migrations folder, so a test can seed a database as it was at that point and apply the rest with
 * {@link deployMigrations}. Only for throwaway databases.
 */
export async function deployMigrationsUpTo(
  databaseUrl: string,
  lastMigration: string,
): Promise<void> {
  const names = await committedMigrations();
  const last = names.indexOf(lastMigration);
  if (last < 0) throw new Error(`Unknown migration: ${lastMigration}`);
  const folder = await mkdtemp(path.join(tmpdir(), 'studio-migrations-'));
  try {
    const copy = path.join(folder, 'migrations');
    await mkdir(copy);
    for (const name of names.slice(0, last + 1)) {
      await cp(path.join(migrationsDir, name), path.join(copy, name), { recursive: true });
    }
    await cp(
      path.join(migrationsDir, 'migration_lock.toml'),
      path.join(copy, 'migration_lock.toml'),
    );
    const config = path.join(folder, 'prisma.config.mjs');
    const settings = {
      schema: path.join(packageRoot, 'prisma', 'schema.prisma'),
      migrations: { path: copy },
    };
    await writeFile(
      config,
      `export default { ...${JSON.stringify(settings)}, datasource: { url: process.env.DATABASE_URL } };
`,
    );
    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    await execFileAsync(process.execPath, [prismaCli, 'migrate', 'deploy', '--config', config], {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Names of the committed migrations (`prisma/migrations/<name>/`), in apply order. */
export async function committedMigrations(): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * The SQL `prisma migrate dev` would generate to bring this database to the Prisma schema
 * (`migrate diff --from-config-datasource --to-schema --script`); only comments when in sync.
 * For tests that check what Prisma sees as drift, e.g. objects it does not model.
 */
export async function schemaDriftScript(databaseUrl: string): Promise<string> {
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      prismaCli,
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      'prisma/schema.prisma',
      '--script',
    ],
    { cwd: packageRoot, env: { ...process.env, DATABASE_URL: databaseUrl } },
  );
  return stdout;
}
