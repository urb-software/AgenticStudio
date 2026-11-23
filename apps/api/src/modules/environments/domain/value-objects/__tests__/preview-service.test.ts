import { describe, expect, it } from 'vitest';
import { InvalidPreviewServiceError, PreviewService } from '../preview-service.js';

describe('PreviewService', () => {
  it.each(['web', 'Web', 'web-1', 'web_2', 'web.app', '1web', 'a'])('accepts %s', (name) => {
    expect(PreviewService.of(name).value).toBe(name);
  });

  it('accepts 63 characters and refuses 64', () => {
    expect(PreviewService.of('a'.repeat(63)).value).toHaveLength(63);
    expect(() => PreviewService.of('a'.repeat(64))).toThrow(InvalidPreviewServiceError);
  });

  it.each([
    ['empty', ''],
    ['starting with a hyphen', '-web'],
    ['starting with a dot', '.web'],
    ['starting with an underscore', '_web'],
    ['with a space', 'my web'],
    ['with a slash', 'a/b'],
    ['with a colon', 'web:80'],
    ['with a non-ASCII letter', 'wéb'],
    ['with a line break', 'web\n'],
  ])('refuses a name %s', (_name, name) => {
    expect(() => PreviewService.of(name)).toThrow(InvalidPreviewServiceError);
  });
});
