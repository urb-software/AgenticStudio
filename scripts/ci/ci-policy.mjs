// PR CI policy for `.github/workflows/ci.yml` (Epic #8 decision 6, Issue #15).
//
//   node scripts/ci/ci-policy.mjs classify < changed-files.txt   # prints `code=true|false`
//   NEEDS='<toJSON(needs)>' node scripts/ci/ci-policy.mjs required # exits 1 unless the PR may pass
//
// Unit tests: `node --test "scripts/ci/*.test.mjs"`.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Docs-only paths: `docs/**`, root `*.md` and `.claude/skills/**`. Everything else, including any
 * `.github/**`, config, tooling, script or test file, runs every code job.
 */
const DOCS_ONLY = [/^docs\//, /^[^/]+\.md$/, /^\.claude\/skills\//];

/** Jobs skipped for a docs-only change and required to succeed for any other change. */
export const CODE_JOBS = [
  'quality-api',
  'quality-web',
  'architecture-api',
  'architecture-web',
  'architecture-monorepo',
  'test-api',
  'test-web',
  'test-contracts',
  'security',
];

/**
 * @param {string[]} files repository-relative paths changed by the PR (both sides of a rename)
 * @returns {{ docsOnly: boolean, codeFiles: string[] }} an empty list is not docs-only (fail safe)
 */
export function classifyChanges(files) {
  const changed = files.map((file) => file.trim()).filter(Boolean);
  const codeFiles = changed.filter((file) => !DOCS_ONLY.some((pattern) => pattern.test(file)));
  return { docsOnly: changed.length > 0 && codeFiles.length === 0, codeFiles };
}

/**
 * Decides `ci:required` from the GitHub Actions `needs` context.
 * @param {Record<string, { result?: string, outputs?: Record<string, string> }>} needs
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function evaluateRequired(needs) {
  const changes = needs.changes;
  if (changes?.result !== 'success') {
    return { ok: false, problems: [`changes: ${changes?.result ?? 'missing'} (expected success)`] };
  }
  const code = changes.outputs?.code;
  if (code !== 'true' && code !== 'false') {
    return { ok: false, problems: ['changes: no `code` classification output'] };
  }
  const expected = code === 'true' ? 'success' : 'skipped';
  const problems = CODE_JOBS.flatMap((job) => {
    const result = needs[job]?.result ?? 'missing';
    return result === expected ? [] : [`${job}: ${result} (expected ${expected})`];
  });
  const unknown = Object.keys(needs).filter((job) => job !== 'changes' && !CODE_JOBS.includes(job));
  problems.push(...unknown.map((job) => `${job}: not in the CI policy (add it to CODE_JOBS)`));
  return { ok: problems.length === 0, problems };
}

function main([command]) {
  if (command === 'classify') {
    const { docsOnly, codeFiles } = classifyChanges(readFileSync(0, 'utf8').split('\n'));
    console.error(
      docsOnly
        ? 'Docs-only change: code jobs are skipped.'
        : `Code jobs run. Files outside the docs-only paths (first 20):\n  ${codeFiles.slice(0, 20).join('\n  ') || '(no changed files reported)'}`,
    );
    console.log(`code=${!docsOnly}`);
    return 0;
  }
  if (command === 'required') {
    const { ok, problems } = evaluateRequired(JSON.parse(process.env.NEEDS ?? '{}'));
    console.log(ok ? 'ci:required passed.' : `ci:required FAILED:\n  ${problems.join('\n  ')}`);
    return ok ? 0 : 1;
  }
  console.error('Usage: ci-policy.mjs classify|required');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
