// Unit tests for the PR CI policy (`scripts/ci/ci-policy.mjs`).
// Run: `node --test "scripts/ci/*.test.mjs"` (CI runs them in the `changes` job before classifying).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODE_JOBS, classifyChanges, evaluateRequired } from './ci-policy.mjs';

describe('classifyChanges', () => {
  const docsOnly = (files) => classifyChanges(files).docsOnly;

  it('treats a PR touching only docs/**, root *.md and .claude/skills/** as docs-only', () => {
    assert.equal(
      docsOnly([
        'docs/engineering/quality.md',
        'docs/architecture/adr/0001-example.md',
        'README.md',
        'AGENTS.md',
        'CLAUDE.md',
        '.claude/skills/studio-pr/SKILL.md',
        '.claude/skills/studio-diagnosing-bugs/scripts/hitl-loop.template.sh',
      ]),
      true,
    );
  });

  it('treats any non-markdown file under docs/ as docs-only', () => {
    assert.equal(docsOnly(['docs/assets/diagram.png']), true);
  });

  it('runs code jobs when one application file changes next to docs', () => {
    assert.equal(docsOnly(['docs/engineering/quality.md', 'apps/api/src/main.ts']), false);
  });

  for (const file of [
    '.github/workflows/ci.yml',
    '.github/pull_request_template.md',
    '.github/ISSUE_TEMPLATE/01-user-story.yml',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.prettierignore',
    '.prettierrc.json',
    '.gitattributes',
    'tsconfig.base.json',
    'eslint.base.mjs',
    'compose.yaml',
    '.env.example',
    'LICENSE',
    'scripts/ci/ci-policy.mjs',
    'tests/architecture/api/gate.ts',
    'packages/database/prisma/schema.prisma',
    'apps/web/README.md',
    'packages/testing/README.md',
    '.claude/settings.json',
    '.claude/skills-other/x.md',
    'docs',
    'README.MD',
    'readme.markdown',
  ]) {
    it(`runs code jobs for ${file}`, () => {
      assert.equal(docsOnly([file]), false);
    });
  }

  it('runs code jobs when nothing is reported as changed (fail safe)', () => {
    assert.equal(docsOnly([]), false);
  });

  it('ignores blank lines and surrounding whitespace in the file list', () => {
    assert.equal(docsOnly(['', '  docs/a.md  ', '\r', 'README.md\r']), true);
  });

  it('reports the files that force code jobs', () => {
    assert.deepEqual(classifyChanges(['README.md', 'apps/api/src/main.ts', 'package.json']), {
      docsOnly: false,
      codeFiles: ['apps/api/src/main.ts', 'package.json'],
    });
  });
});

describe('ci-policy.mjs classify (CLI used by the workflow)', () => {
  const script = fileURLToPath(new URL('./ci-policy.mjs', import.meta.url));
  const classify = (input) =>
    execFileSync(process.execPath, [script, 'classify'], {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

  it('prints code=false for a docs-only file list', () => {
    assert.equal(classify('docs/a.md\nREADME.md\n'), 'code=false');
  });

  it('prints code=true when code moves into docs/ (git diff --no-renames lists both sides)', () => {
    assert.equal(classify('apps/api/src/main.ts\ndocs/main.ts\n'), 'code=true');
  });

  it('prints code=true for an empty file list', () => {
    assert.equal(classify(''), 'code=true');
  });
});

describe('evaluateRequired', () => {
  it('requires every code job of the workflow', () => {
    assert.deepEqual(CODE_JOBS, [
      'quality-api',
      'quality-web',
      'architecture-api',
      'architecture-web',
      'architecture-monorepo',
      'test-api',
      'test-web',
      'test-contracts',
      'e2e-smoke',
      'security',
    ]);
  });

  const needs = (code, codeJobResult, overrides = {}) => ({
    changes: { result: 'success', outputs: { code: String(code) } },
    ...Object.fromEntries(CODE_JOBS.map((job) => [job, { result: codeJobResult, outputs: {} }])),
    ...overrides,
  });

  it('passes when code changed and every code job succeeded', () => {
    assert.equal(evaluateRequired(needs(true, 'success')).ok, true);
  });

  it('passes a docs-only change whose code jobs were skipped', () => {
    assert.equal(evaluateRequired(needs(false, 'skipped')).ok, true);
  });

  for (const result of ['failure', 'cancelled', 'skipped']) {
    it(`fails when code changed and a code job is ${result}`, () => {
      const verdict = evaluateRequired(
        needs(true, 'success', { 'architecture-api': { result, outputs: {} } }),
      );
      assert.equal(verdict.ok, false);
      assert.match(verdict.problems.join('\n'), /architecture-api/);
    });
  }

  it('fails a docs-only change if a code job ran anyway', () => {
    const verdict = evaluateRequired(
      needs(false, 'skipped', { 'test-api': { result: 'failure', outputs: {} } }),
    );
    assert.equal(verdict.ok, false);
  });

  for (const result of ['failure', 'cancelled', 'skipped']) {
    it(`fails when the changes job is ${result}`, () => {
      const verdict = evaluateRequired(
        needs(false, 'skipped', { changes: { result, outputs: {} } }),
      );
      assert.equal(verdict.ok, false);
      assert.match(verdict.problems.join('\n'), /changes/);
    });
  }

  it('fails when the changes job did not report a classification', () => {
    const verdict = evaluateRequired(
      needs(false, 'skipped', { changes: { result: 'success', outputs: {} } }),
    );
    assert.equal(verdict.ok, false);
  });

  it('fails on a job in needs that the policy does not know (keeps workflow and policy in sync)', () => {
    const verdict = evaluateRequired(
      needs(true, 'success', { 'nightly-e2e': { result: 'success', outputs: {} } }),
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems.join('\n'), /nightly-e2e/);
  });

  it('fails when a required code job is missing from needs', () => {
    const all = needs(true, 'success');
    delete all['test-contracts'];
    const verdict = evaluateRequired(all);
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems.join('\n'), /test-contracts/);
  });
});

/**
 * Minimal reader for the jobs of `.github/workflows/ci.yml` as written there (two-space YAML
 * indentation): job id → { name, needs, if, uses } (`uses` = the job's step actions, in order).
 * No YAML dependency, because the `changes` job
 * runs these tests before `pnpm install`.
 */
function readWorkflowJobs(text) {
  const jobs = {};
  let inJobs = false;
  let current;
  let inNeedsList = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs || line.trim() === '' || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;
    const job = /^ {2}([\w-]+):\s*$/.exec(line);
    if (job) {
      current = jobs[job[1]] = { needs: [], uses: [] };
      inNeedsList = false;
      continue;
    }
    if (!current) continue;
    const step = /^ {6}(?:- | {2})uses:\s*(\S+)/.exec(line);
    if (step) {
      current.uses.push(step[1]);
      continue;
    }
    const field = /^ {4}([\w-]+):\s*(.*?)\s*$/.exec(line);
    if (field) {
      const [, key, value] = field;
      inNeedsList = key === 'needs' && value === '';
      if (key === 'needs' && value !== '') current.needs = [value];
      if (key === 'name' || key === 'if') current[key] = value;
      continue;
    }
    const item = /^ {6}- ([\w-]+)\s*$/.exec(line);
    if (inNeedsList && item) current.needs.push(item[1]);
  }
  return jobs;
}

describe('.github/workflows/ci.yml stays in sync with the policy (#28 drift gap)', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const jobs = readWorkflowJobs(workflow);
  const required = jobs['ci-required'];

  it('reads the jobs of the workflow', () => {
    assert.ok(required, 'ci-required job not found');
    assert.ok(required.needs.length > 1, JSON.stringify(required));
  });

  it('makes ci:required need exactly `changes` and every policy code job', () => {
    assert.deepEqual([...required.needs].sort(), ['changes', ...CODE_JOBS].sort());
  });

  it('lets no workflow job escape ci:required', () => {
    const unchecked = Object.keys(jobs).filter(
      (id) => id !== 'ci-required' && !required.needs.includes(id),
    );
    assert.deepEqual(unchecked, []);
  });

  it('runs every policy code job after `changes`, gated on its classification', () => {
    for (const id of CODE_JOBS) {
      assert.ok(jobs[id], `${id} is missing from ci.yml`);
      assert.deepEqual(jobs[id].needs, ['changes'], id);
      assert.equal(jobs[id].if, "needs.changes.outputs.code == 'true'", id);
    }
  });

  it('names every job after its quality.md §7 check (first `-` of the id becomes `:`)', () => {
    for (const [id, job] of Object.entries(jobs)) {
      assert.equal(job.name, id.replace('-', ':'), id);
    }
  });

  it('always runs ci:required', () => {
    assert.equal(required.if, 'always()');
  });

  it('notices a code job dropped from ci:required needs (reader self-check)', () => {
    const broken = readWorkflowJobs(workflow.replace(/^ {6}- e2e-smoke\r?\n/m, ''));
    assert.ok(!broken['ci-required'].needs.includes('e2e-smoke'));
    assert.notDeepEqual([...broken['ci-required'].needs].sort(), ['changes', ...CODE_JOBS].sort());
  });
});

/** `uses:` references of a file (workflow or composite action), without trailing comments. */
const usesRefs = (text) =>
  [...text.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((match) => match[1]);

describe('.github/actions/setup composite action (#28 setup de-duplication)', () => {
  const actionsDir = new URL('../../.github/actions/', import.meta.url);
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const jobs = readWorkflowJobs(workflow);
  const actionFiles = readdirSync(actionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => new URL(`${entry.name}/action.yml`, actionsDir));
  const setup = readFileSync(new URL('setup/action.yml', actionsDir), 'utf8');

  it('pins every external action by full commit SHA (workflow and local actions)', () => {
    const refs = [workflow, ...actionFiles.map((file) => readFileSync(file, 'utf8'))].flatMap(
      usesRefs,
    );
    assert.ok(refs.length > 0);
    for (const ref of refs) {
      if (ref.startsWith('./')) continue;
      assert.match(ref, /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/, ref);
    }
  });

  it('checks out the repository before a job uses a local action', () => {
    for (const [id, job] of Object.entries(jobs)) {
      const local = job.uses.findIndex((ref) => ref.startsWith('./'));
      if (local === -1) continue;
      const checkout = job.uses.findIndex((ref) => ref.startsWith('actions/checkout@'));
      assert.ok(checkout !== -1 && checkout < local, `${id}: ${job.uses.join(', ')}`);
    }
  });

  it('sets up pnpm only through the shared setup action', () => {
    for (const [id, job] of Object.entries(jobs)) {
      assert.ok(!job.uses.some((ref) => ref.startsWith('pnpm/action-setup@')), id);
    }
    assert.ok(usesRefs(setup).some((ref) => ref.startsWith('pnpm/action-setup@')));
  });

  it('is used by every policy code job', () => {
    for (const id of CODE_JOBS) {
      assert.ok(jobs[id].uses.includes('./.github/actions/setup'), `${id}: ${jobs[id].uses}`);
    }
  });

  it('installs with the frozen lockfile', () => {
    assert.match(setup, /run: pnpm install --frozen-lockfile/);
  });
});
