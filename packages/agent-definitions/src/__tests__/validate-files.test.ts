import { describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES, MAX_FILES, MAX_FOLDER_BYTES, validateAgentFiles } from '../index.js';
import { binary, file } from './fixtures.js';

const codes = (problems: { code: string; path: string }[]) =>
  problems.map((problem) => `${problem.code}@${problem.path}`).sort();

describe('validateAgentFiles', () => {
  it('accepts a folder without its entry file: scripts and assets', () => {
    expect(
      validateAgentFiles([file('scripts/run.sh', '#!/bin/sh\n'), binary('assets/logo.png', 2048)]),
    ).toEqual([]);
  });

  it('applies the path rules of the folder validation', () => {
    expect(
      codes(
        validateAgentFiles([
          file('../escape.sh', 'x'),
          file('.hidden', 'x'),
          file('docs/CLAUDE.md', 'x'),
          file('a/.git/config', 'x'),
        ]),
      ),
    ).toEqual([
      'cli_config_path@.hidden',
      'cli_config_path@docs/CLAUDE.md',
      'nested_git@a/.git/config',
      'path_outside_folder@../escape.sh',
    ]);
  });

  it('refuses a symbolic link, another kind and a duplicate path', () => {
    expect(
      codes(
        validateAgentFiles([
          { path: 'link', kind: 'symlink', size: 0 },
          { path: 'sub', kind: 'submodule', size: 0 },
          file('Same.txt', 'a'),
          file('same.txt', 'b'),
        ]),
      ),
    ).toEqual(['duplicate_path@same.txt', 'kind_refused@sub', 'symlink_refused@link']);
  });

  it('applies the limits of file count, file size and folder size', () => {
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => file(`f${i}.txt`, 'x'));
    expect(codes(validateAgentFiles(many))).toEqual(['too_many_files@']);
    expect(codes(validateAgentFiles([binary('big.bin', MAX_FILE_BYTES + 1)]))).toEqual([
      'file_too_large@big.bin',
    ]);
    const spread = Array.from({ length: 6 }, (_, i) => binary(`f${i}.bin`, MAX_FOLDER_BYTES / 5));
    expect(codes(validateAgentFiles(spread))).toEqual(['folder_too_large@']);
  });
});
