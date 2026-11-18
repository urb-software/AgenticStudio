import { describe, expect, it } from 'vitest';
import { EnvironmentFileContent } from '../environment-file-content.js';

describe('EnvironmentFileContent', () => {
  it('takes the value of each KEY=VALUE line, with or without export, quotes stripped', () => {
    const content = [
      'DB_PASSWORD=test-only-pw',
      'export API_KEY="test key with spaces"',
      "TOKEN='single-quoted'",
      'SPACED = around-equals ',
    ].join('\n');

    expect(EnvironmentFileContent.of(content).valuesToRedact()).toEqual([
      'test-only-pw',
      'test key with spaces',
      'single-quoted',
      'around-equals',
    ]);
  });

  it('leaves out values shorter than 4 characters', () => {
    expect(
      EnvironmentFileContent.of('DEBUG=1\nMODE=dev\nPORT=5432\nEMPTY=\nQ=""').valuesToRedact(),
    ).toEqual(['5432']);
  });

  it('adds lines that are not KEY=VALUE whole when they have at least 8 characters', () => {
    const content = '-----BEGIN TEST BLOCK-----\nabc\nnot a pair but long\n';
    expect(EnvironmentFileContent.of(content).valuesToRedact()).toEqual([
      '-----BEGIN TEST BLOCK-----',
      'not a pair but long',
    ]);
  });

  it('skips blank lines and comments, but redacts a commented-out pair', () => {
    const content = '\n# Settings for the test stack\n  \n#OLD_SECRET=test-only-old\n';
    expect(EnvironmentFileContent.of(content).valuesToRedact()).toEqual(['test-only-old']);
  });

  it('also takes an unquoted value without its trailing comment', () => {
    expect(EnvironmentFileContent.of('KEY=test-value # the key').valuesToRedact()).toEqual([
      'test-value # the key',
      'test-value',
    ]);
  });

  it('reads Windows line endings', () => {
    expect(
      EnvironmentFileContent.of('A=first-value\r\nB=second-value\r\n').valuesToRedact(),
    ).toEqual(['first-value', 'second-value']);
  });

  it('returns each value once', () => {
    expect(EnvironmentFileContent.of('A=same-value\nB=same-value').valuesToRedact()).toEqual([
      'same-value',
    ]);
  });
});
