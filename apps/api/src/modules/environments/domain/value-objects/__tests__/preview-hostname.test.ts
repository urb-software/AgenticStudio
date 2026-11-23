import { describe, expect, it } from 'vitest';
import { PreviewHostname } from '../preview-hostname.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

describe('PreviewHostname', () => {
  it('is preview-, the first 12 hex digits of the id without dashes, and the domain', () => {
    expect(PreviewHostname.of(PROJECT, 'example.test').value).toBe(
      'preview-3f2b8c1e4d5a.example.test',
    );
  });

  it('is the same for every call and lower case for an upper-case id', () => {
    const first = PreviewHostname.of(PROJECT, 'preview.example.test').value;

    expect(PreviewHostname.of(PROJECT, 'preview.example.test').value).toBe(first);
    expect(PreviewHostname.of(PROJECT.toUpperCase(), 'preview.example.test').value).toBe(first);
  });

  it('keeps its label well under the 63 characters of a DNS label', () => {
    const label = PreviewHostname.of(PROJECT, 'example.test').value.split('.')[0]!;

    expect(label).toHaveLength('preview-'.length + PreviewHostname.ID_DIGITS);
    expect(label.length).toBeLessThan(32);
  });

  it('differs between projects', () => {
    const other = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

    expect(PreviewHostname.of(other, 'example.test').value).not.toBe(
      PreviewHostname.of(PROJECT, 'example.test').value,
    );
  });
});
