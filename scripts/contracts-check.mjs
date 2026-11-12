// `pnpm contracts:check`: regenerates the OpenAPI document and the web client, then
// fails if the result differs from what is committed (modified, deleted or new files).
import { execFileSync, execSync } from 'node:child_process';

const GENERATED_PATHS = ['apps/api/openapi.json', 'apps/web/src/platform/api/generated'];

execSync('pnpm run contracts:generate', { stdio: 'inherit' });

const drift = execFileSync(
  'git',
  ['status', '--porcelain', '--untracked-files=all', '--', ...GENERATED_PATHS],
  { encoding: 'utf8' },
).trim();

if (drift) {
  console.error('\ncontracts:check FAILED: generated contracts differ from the committed version:');
  console.error(drift);
  execFileSync('git', ['--no-pager', 'diff', '--stat', '--', ...GENERATED_PATHS], {
    stdio: 'inherit',
  });
  console.error('\nRun `pnpm contracts:generate` and commit the result.');
  process.exit(1);
}

console.log('\ncontracts:check passed: generated contracts match the committed version.');
