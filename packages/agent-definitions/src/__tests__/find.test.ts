import { describe, expect, it } from 'vitest';
import { findAgentFolders } from '../index.js';
import { binary, entryFile, file, VALID_FRONT } from './fixtures.js';

const at = (prefix: string, entry: ReturnType<typeof file>) => ({
  ...entry,
  path: `${prefix}${entry.path}`,
});

describe('findAgentFolders', () => {
  it('groups the entries of each agents/<name>/ folder, with paths relative to it', () => {
    const folders = findAgentFolders([
      at('agents/reviewer/', entryFile(VALID_FRONT)),
      at('agents/reviewer/', binary('assets/logo.png', 10)),
      at('agents/planner/', entryFile('name: planner')),
    ]);
    expect(folders.map((folder) => folder.name).sort()).toEqual(['planner', 'reviewer']);
    const reviewer = folders.find((folder) => folder.name === 'reviewer');
    expect(reviewer?.entries.map((entry) => entry.path)).toEqual(['AGENT.md', 'assets/logo.png']);
  });

  it('ignores skills/, the top level and loose files directly under agents/', () => {
    const folders = findAgentFolders([
      file('README.md', 'x'),
      at('skills/helper/', file('SKILL.md', 'x')),
      file('agents/README.md', 'x'),
      { path: 'agents', kind: 'directory', size: 0 },
      { path: 'docs/agents/x/AGENT.md', kind: 'file', size: 1 },
      at('agents/reviewer/', entryFile(VALID_FRONT)),
    ]);
    expect(folders.map((folder) => folder.name)).toEqual(['reviewer']);
  });

  it('keeps a directory entry of the folder itself out of the entries', () => {
    const folders = findAgentFolders([
      { path: 'agents/reviewer', kind: 'directory', size: 0 },
      at('agents/reviewer/', entryFile(VALID_FRONT)),
    ]);
    expect(folders[0]?.entries.map((entry) => entry.path)).toEqual(['AGENT.md']);
  });

  it('keeps a folder that is itself a symbolic link, so validation refuses it', () => {
    const folders = findAgentFolders([{ path: 'agents/evil', kind: 'symlink', size: 3 }]);
    expect(folders.map((folder) => folder.name)).toEqual(['evil']);
  });

  it('is pure: the same input gives the same output', () => {
    const input = [at('agents/a/', entryFile('name: a'))];
    expect(findAgentFolders(input)).toEqual(findAgentFolders(input));
  });
});
