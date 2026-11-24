import { describe, expect, it } from 'vitest';
import { environmentFileValuesToRedact } from '../index.js';

describe('environmentFileValuesToRedact', () => {
  it('takes the value of each KEY=VALUE line, with or without export, quotes stripped', () => {
    const content = [
      'DB_PASSWORD=test-only-pw',
      'export API_KEY="test key with spaces"',
      "TOKEN='single-quoted'",
      'SPACED = around-equals ',
    ].join('\n');
    expect(environmentFileValuesToRedact(content)).toEqual([
      'test-only-pw',
      'test key with spaces',
      'single-quoted',
      'around-equals',
    ]);
  });

  it('leaves out values shorter than 4 characters', () => {
    expect(environmentFileValuesToRedact('DEBUG=1\nMODE=dev\nPORT=5432\nEMPTY=\nQ=""')).toEqual([
      '5432',
    ]);
  });

  it('adds lines that are not KEY=VALUE whole when they have at least 8 characters', () => {
    expect(
      environmentFileValuesToRedact('-----BEGIN TEST BLOCK-----\nabc\nnot a pair but long\n'),
    ).toEqual(['-----BEGIN TEST BLOCK-----', 'not a pair but long']);
  });

  it('skips blank lines and comments, but redacts a commented-out pair', () => {
    expect(
      environmentFileValuesToRedact(
        '\n# Settings for the test stack\n  \n#OLD_SECRET=test-only-old\n',
      ),
    ).toEqual(['test-only-old']);
  });

  it('also takes an unquoted value without its trailing comment', () => {
    expect(environmentFileValuesToRedact('KEY=test-value # the key')).toEqual([
      'test-value # the key',
      'test-value',
    ]);
  });

  it('reads Windows line endings and returns each value once', () => {
    expect(environmentFileValuesToRedact('A=first-value\r\nB=first-value\r\n')).toEqual([
      'first-value',
    ]);
  });
});
