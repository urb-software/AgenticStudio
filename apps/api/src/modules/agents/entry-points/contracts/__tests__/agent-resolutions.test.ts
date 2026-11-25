import { describe, expect, it, vi } from 'vitest';
import type {
  DefinitionsFiles,
  DefinitionsFilesResult,
  DefinitionsSnapshot,
  DefinitionsTreeEntry,
  DefinitionsTreeResult,
} from '../../../../projects/contracts/index.js';
import { ReadAgentsHandler } from '../../../application/features/read-agents/handler.js';
import { ReadAgentsAgentResolutions } from '../agent-resolutions.js';

const COMMIT = 'a'.repeat(40);

const entry = (name: string, provider: string, model = ''): string =>
  `---\nname: ${name}\ndescription: Does ${name}\nprovider: ${provider}\n${model}---\nInstructions of ${name}.\n`;

const file = (path: string): DefinitionsTreeEntry => ({ path, kind: 'file', size: 10 });

function resolutions(files: Record<string, string>, snapshot: DefinitionsSnapshot | null) {
  const fake = {
    snapshot: vi.fn(() => Promise.resolve(snapshot)),
    listTree: vi.fn((): Promise<DefinitionsTreeResult> =>
      Promise.resolve({
        status: 'listed',
        entries: Object.keys(files).map(file),
        truncated: false,
      }),
    ),
    readFiles: vi.fn((_commit: string, paths: readonly string[]): Promise<DefinitionsFilesResult> =>
      Promise.resolve({
        status: 'read',
        files: paths.map((path) =>
          path in files
            ? { path, status: 'found' as const, text: files[path]! }
            : { path, status: 'missing' as const },
        ),
      }),
    ),
  } satisfies DefinitionsFiles;
  return new ReadAgentsAgentResolutions(new ReadAgentsHandler(fake));
}

const READY = { state: 'ready', commit: COMMIT } as const;

describe('ReadAgentsAgentResolutions', () => {
  it('resolves a built-in agent without a Repository: no commit, no instructions', async () => {
    const resolved = await resolutions({}, null).resolveForRun('default-codex');

    expect(resolved).toEqual({
      status: 'resolved',
      agent: {
        name: 'default-codex',
        source: 'built_in',
        commit: null,
        provider: 'codex',
        model: 'default',
        instructions: '',
      },
    });
  });

  it('resolves a definitions agent at the commit it was read at, with its model and instructions', async () => {
    const resolved = await resolutions(
      { 'agents/reviewer/AGENT.md': entry('reviewer', 'claude_code', 'model: opus\n') },
      READY,
    ).resolveForRun('reviewer');

    expect(resolved).toEqual({
      status: 'resolved',
      agent: {
        name: 'reviewer',
        source: 'definitions',
        commit: COMMIT,
        provider: 'claude_code',
        model: 'opus',
        instructions: 'Instructions of reviewer.\n',
      },
    });
  });

  it('refuses a folder whose definition has problems as not usable', async () => {
    const resolved = await resolutions(
      { 'agents/broken/AGENT.md': '---\nname: broken\n---\nNo provider.\n' },
      READY,
    ).resolveForRun('broken');

    expect(resolved).toEqual({ status: 'not_usable' });
  });

  it('refuses a name no agent has as unknown', async () => {
    await expect(
      resolutions({ 'agents/reviewer/AGENT.md': entry('reviewer', 'codex') }, READY).resolveForRun(
        'nobody',
      ),
    ).resolves.toEqual({ status: 'unknown' });
  });

  it('does not find a definitions agent while no Repository is connected', async () => {
    await expect(resolutions({}, null).resolveForRun('reviewer')).resolves.toEqual({
      status: 'unknown',
    });
  });

  it('keeps the built-in agent when a folder is named like it', async () => {
    const resolved = await resolutions(
      { 'agents/default-codex/AGENT.md': entry('default-codex', 'codex') },
      READY,
    ).resolveForRun('default-codex');

    expect(resolved).toMatchObject({
      status: 'resolved',
      agent: { source: 'built_in', commit: null, instructions: '' },
    });
  });
});
