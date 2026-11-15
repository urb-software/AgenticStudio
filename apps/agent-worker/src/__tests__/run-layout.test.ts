import { describe, expect, it } from 'vitest';
import {
  cacheDirectory,
  composeProjectName,
  runBranchName,
  runDirectories,
  UnsafeIdentifierError,
} from '../run-layout.js';

// Issue #98: names and paths of a Run on the agent side, built only from identifiers.
const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const OTHER_RUN_ID = '7c1d9e3a-4b5f-4a6c-8d7e-9f0a1b2c3d4e';
const PROJECT_ID = '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b';
const DATA_DIR = '/var/lib/studio-agent';

describe('runBranchName', () => {
  it('names the Run branch from the Task and the Run', () => {
    expect(runBranchName('Add pagination', RUN_ID)).toBe('agent/add-pagination-r0b8e5c2d');
  });

  it('sanitises the Task to lowercase ASCII letters, digits and dashes', () => {
    expect(runBranchName('  Fix the LOGIN bug!! (urgent) ', RUN_ID)).toBe(
      'agent/fix-the-login-bug-urgent-r0b8e5c2d',
    );
    expect(runBranchName('Café über straße', RUN_ID)).toBe('agent/cafe-uber-stra-e-r0b8e5c2d');
    expect(runBranchName('../../refs/heads/main.lock', RUN_ID)).toBe(
      'agent/refs-heads-main-lock-r0b8e5c2d',
    );
  });

  it('keeps at most 40 characters of the Task, never ending in a dash', () => {
    const name = runBranchName(`${'abcdefghi '.repeat(10)}`, RUN_ID);
    const slug = name.slice('agent/'.length, -'-r0b8e5c2d'.length);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toBe('abcdefghi-abcdefghi-abcdefghi-abcdefghi');
  });

  it('falls back to "run" when nothing of the Task is left', () => {
    expect(runBranchName('!!! ??? 日本語', RUN_ID)).toBe('agent/run-r0b8e5c2d');
  });

  it('gives Runs with the same Task different names', () => {
    expect(runBranchName('Add pagination', RUN_ID)).not.toBe(
      runBranchName('Add pagination', OTHER_RUN_ID),
    );
  });

  it('refuses an identifier that is not a UUID', () => {
    expect(() => runBranchName('x', '../../etc')).toThrow(UnsafeIdentifierError);
  });
});

describe('composeProjectName', () => {
  it('is studio-run- and the first 12 hex digits of the Run id', () => {
    expect(composeProjectName(RUN_ID)).toBe('studio-run-0b8e5c2d1f3a');
  });
});

describe('Run directories', () => {
  it("keeps the Working copy and, beside it, the Task, the Run file and the agent's result", () => {
    expect(runDirectories(DATA_DIR, RUN_ID)).toEqual({
      runDir: `${DATA_DIR}/runs/${RUN_ID}`,
      repoDir: `${DATA_DIR}/runs/${RUN_ID}/repo`,
      taskFile: `${DATA_DIR}/runs/${RUN_ID}/task.md`,
      runFile: `${DATA_DIR}/runs/${RUN_ID}/run.json`,
      processesFile: `${DATA_DIR}/runs/${RUN_ID}/step-processes`,
      resultFile: `${DATA_DIR}/runs/${RUN_ID}/result.json`,
    });
  });

  it('keeps one cache per Project', () => {
    expect(cacheDirectory(DATA_DIR, PROJECT_ID)).toBe(`${DATA_DIR}/cache/${PROJECT_ID}.git`);
  });

  it.each([
    ['a parent reference', '../../etc'],
    ['an absolute path', '/etc/passwd'],
    ['a UUID with a path after it', `${RUN_ID}/../../x`],
    ['an empty id', ''],
    ['a UUID-like id with a dot', `${RUN_ID.slice(0, -1)}.`],
  ])('refuses %s as an identifier, so no path can escape the data directory', (_case, id) => {
    expect(() => runDirectories(DATA_DIR, id)).toThrow(UnsafeIdentifierError);
    expect(() => cacheDirectory(DATA_DIR, id)).toThrow(UnsafeIdentifierError);
  });

  it('refuses a relative data directory', () => {
    expect(() => runDirectories('data', RUN_ID)).toThrow(UnsafeIdentifierError);
  });
});
