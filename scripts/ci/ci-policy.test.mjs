// Unit tests for the PR CI policy (`scripts/ci/ci-policy.mjs`).
// Run: `node --test scripts/ci/` (CI runs them in the `changes` job before classifying).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyChanges, evaluateRequired } from './ci-policy.mjs';

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

describe('evaluateRequired', () => {
  const CODE_JOBS = [
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
      needs(true, 'success', { 'e2e-smoke': { result: 'success', outputs: {} } }),
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems.join('\n'), /e2e-smoke/);
  });

  it('fails when a required code job is missing from needs', () => {
    const all = needs(true, 'success');
    delete all['test-contracts'];
    const verdict = evaluateRequired(all);
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems.join('\n'), /test-contracts/);
  });
});
