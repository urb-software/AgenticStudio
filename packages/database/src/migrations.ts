import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..');

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
