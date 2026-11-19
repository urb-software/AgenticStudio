import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createdTestDataDirs, testConfig } from './test-config.js';

describe('testConfig data directory', () => {
  it('gives every call its own existing directory under the temp directory', () => {
    const first = testConfig().dataDir;
    const second = testConfig().dataDir;

    expect(first).not.toBe(second);
    expect(dirname(first)).toBe(tmpdir());
    expect(dirname(second)).toBe(tmpdir());
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  it('keeps an explicit data directory and creates nothing for it', () => {
    const before = createdTestDataDirs();
    const explicit = join(tmpdir(), 'studio-explicit-data-dir-that-must-not-exist');

    expect(testConfig({ dataDir: explicit }).dataDir).toBe(explicit);
    expect(existsSync(explicit)).toBe(false);
    expect(createdTestDataDirs()).toEqual(before);
  });
});
