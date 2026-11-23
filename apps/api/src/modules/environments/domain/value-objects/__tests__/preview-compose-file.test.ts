import { describe, expect, it } from 'vitest';
import { InvalidPreviewComposeFileError, PreviewComposeFile } from '../preview-compose-file.js';

describe('PreviewComposeFile', () => {
  it.each(['compose.yaml', 'docker-compose.yml', 'deploy/preview/compose.yaml', 'a.b/c_d/e-f.yml'])(
    'accepts the relative POSIX path %s',
    (path) => {
      expect(PreviewComposeFile.of(path).value).toBe(path);
    },
  );

  it('accepts a path of exactly 255 characters and refuses 256', () => {
    const longest = `${'a'.repeat(251)}.yml`;
    expect(longest).toHaveLength(PreviewComposeFile.MAX_LENGTH);
    expect(PreviewComposeFile.of(longest).value).toBe(longest);
    expect(() => PreviewComposeFile.of(`${longest}x`)).toThrow(InvalidPreviewComposeFileError);
  });

  it.each([
    ['empty', ''],
    ['absolute', '/etc/compose.yaml'],
    ['with a .. segment', 'deploy/../compose.yaml'],
    ['starting with ..', '../compose.yaml'],
    ['only ..', '..'],
    ['with a backslash', 'deploy\\compose.yaml'],
    ['with a NUL byte', 'compose\u0000.yaml'],
    ['with another control character', 'compose\n.yaml'],
    ['with a leading ./', './compose.yaml'],
    ['with a . segment', 'deploy/./compose.yaml'],
    ['with an empty segment', 'deploy//compose.yaml'],
    ['with a trailing slash', 'deploy/'],
    ['inside .git', '.git/config'],
    ['inside a nested .git', 'vendor/.GIT/config'],
  ])('refuses a path %s', (_name, path) => {
    expect(() => PreviewComposeFile.of(path)).toThrow(InvalidPreviewComposeFileError);
  });

  it('says why, without quoting the path', () => {
    const secret = 'secret-folder';
    try {
      PreviewComposeFile.of(`${secret}/../compose.yaml`);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/\.\./);
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
