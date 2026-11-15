import { describe, expect, it } from 'vitest';
import { environmentFileValues } from '../environment-file-values.js';

// Issue #104: the values of a Run's Environment file that log redaction replaces. Test values.

describe('environmentFileValues', () => {
  it('takes the value of each KEY=VALUE line, with or without export, quotes stripped', () => {
    const content = [
      'DB_PASSWORD=test-only-pw',
      'export API_KEY="test key with spaces"',
      "TOKEN='single-quoted'",
      'SPACED = around-equals ',
    ].join('\n');

    expect(environmentFileValues(content)).toEqual([
      'test-only-pw',
      'test key with spaces',
      'single-quoted',
      'around-equals',
    ]);
  });

  it('leaves out values shorter than 4 characters', () => {
    expect(environmentFileValues('DEBUG=1\nMODE=dev\nPORT=5432\nEMPTY=\nQ=""')).toEqual(['5432']);
  });

  it('adds lines that are not KEY=VALUE whole when they have at least 8 characters', () => {
    const content = '-----BEGIN TEST BLOCK-----\nabc\nnot a pair but long\n';
    expect(environmentFileValues(content)).toEqual([
      '-----BEGIN TEST BLOCK-----',
      'not a pair but long',
    ]);
  });

  it('skips blank lines and comments, but redacts a commented-out pair', () => {
    const content = '\n# Settings for the test stack\n  \n#OLD_SECRET=test-only-old\n';
    expect(environmentFileValues(content)).toEqual(['test-only-old']);
  });

  it('also takes an unquoted value without its trailing comment', () => {
    expect(environmentFileValues('KEY=test-value # the key')).toEqual([
      'test-value # the key',
      'test-value',
    ]);
  });

  it('reads Windows line endings', () => {
    expect(environmentFileValues('A=first-value\r\nB=second-value\r\n')).toEqual([
      'first-value',
      'second-value',
    ]);
  });

  it('returns each value once', () => {
    expect(environmentFileValues('A=same-value\nB=same-value')).toEqual(['same-value']);
  });
});
