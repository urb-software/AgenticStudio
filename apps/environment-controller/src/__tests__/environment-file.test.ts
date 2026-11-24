import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeEnvironmentFile } from '../environment-file.js';
import { OperationFailure } from '../failure.js';

let src: string;
beforeEach(() => {
  src = mkdtempSync(join(tmpdir(), 'controller-envfile-'));
});
afterEach(() => rmSync(src, { recursive: true, force: true }));

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OperationFailure);
    return (error as OperationFailure).code;
  }
  return 'none';
};

describe('writeEnvironmentFile', () => {
  it('writes the content at the path, making missing parent directories', async () => {
    await writeEnvironmentFile(src, 'config/deep/app.env', 'A=1\n');
    expect(readFileSync(join(src, 'config/deep/app.env'), 'utf8')).toBe('A=1\n');
    if (process.platform !== 'win32') {
      expect(statSync(join(src, 'config/deep/app.env')).mode & 0o777).toBe(0o600);
    }
  });

  it('writes into an existing real directory', async () => {
    mkdirSync(join(src, 'config'));
    writeFileSync(join(src, 'config/other.txt'), 'x');
    await writeEnvironmentFile(src, 'config/app.env', 'A=1\n');
    expect(readFileSync(join(src, 'config/app.env'), 'utf8')).toBe('A=1\n');
    expect(readFileSync(join(src, 'config/other.txt'), 'utf8')).toBe('x');
  });

  it('refuses a path where the source already has a file, and leaves it unchanged', async () => {
    writeFileSync(join(src, '.env'), 'TRACKED=1\n');
    expect(await codeOf(writeEnvironmentFile(src, '.env', 'A=1\n'))).toBe(
      'environment_file_tracked',
    );
    expect(readFileSync(join(src, '.env'), 'utf8')).toBe('TRACKED=1\n');
  });

  it('refuses a path below a tracked file, and a directory at the path', async () => {
    writeFileSync(join(src, 'config'), 'a file');
    expect(await codeOf(writeEnvironmentFile(src, 'config/app.env', 'A=1\n'))).toBe(
      'environment_file_tracked',
    );
    mkdirSync(join(src, 'dir'));
    expect(await codeOf(writeEnvironmentFile(src, 'dir', 'A=1\n'))).toBe(
      'environment_file_tracked',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink at the path or as a parent',
    async () => {
      mkdirSync(join(src, 'real'));
      symlinkSync('real', join(src, 'link'));
      symlinkSync('real/target', join(src, 'file-link'));
      expect(await codeOf(writeEnvironmentFile(src, 'link/app.env', 'A=1\n'))).toBe(
        'environment_file_tracked',
      );
      expect(await codeOf(writeEnvironmentFile(src, 'file-link', 'A=1\n'))).toBe(
        'environment_file_tracked',
      );
      expect(() => statSync(join(src, 'real/target'))).toThrow();
    },
  );

  it.each(['', '/etc/passwd', '../x', 'a/../../x', 'a//b', 'a\\b', 'a/./b', 'a\0b'])(
    'refuses the path %j without writing',
    async (path) => {
      expect(await codeOf(writeEnvironmentFile(src, path, 'A=1\n'))).toBe('controller_error');
    },
  );
});
