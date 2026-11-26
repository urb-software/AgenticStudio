import { describe, expect, it, vi } from 'vitest';
import type {
  DefinitionsBlobsResult,
  ProjectDefaultAgents,
  DefinitionsFiles,
  DefinitionsFilesResult,
  DefinitionsSnapshot,
  DefinitionsTreeEntry,
  DefinitionsTreeResult,
} from '../../../../projects/contracts/index.js';
import { ReadAgentsHandler } from '../../../application/features/read-agents/handler.js';
import { AgentsReader } from '../../../application/agents-reader.js';
import { SkillsReader } from '../../../application/skills-reader.js';
import { ReadAgentsAgentResolutions } from '../agent-resolutions.js';

const COMMIT = 'a'.repeat(40);

const entry = (name: string, provider: string, model = ''): string =>
  `---\nname: ${name}\ndescription: Does ${name}\nprovider: ${provider}\n${model}---\nInstructions of ${name}.\n`;

const file = (path: string): DefinitionsTreeEntry => ({
  path,
  kind: 'file',
  size: 10,
  executable: false,
});

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
            ? {
                path,
                status: 'found' as const,
                text: files[path]!,
                size: files[path]!.length,
                binary: false,
              }
            : { path, status: 'missing' as const, size: 0 as const },
        ),
      }),
    ),
    readBlobs: vi.fn((): Promise<DefinitionsBlobsResult> =>
      Promise.resolve({ status: 'read', files: [] }),
    ),
    blobIds: vi.fn(() => Promise.reject(new Error('not used'))),
  } satisfies DefinitionsFiles;
  const defaults: ProjectDefaultAgents = {
    forProject: () => Promise.resolve({ status: 'project_not_found' }),
  };
  return new ReadAgentsAgentResolutions(
    new ReadAgentsHandler(new AgentsReader(fake, new SkillsReader(fake)), defaults),
  );
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
        skills: [],
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
        skills: [],
      },
    });
  });

  it('resolves the names of the skills the definition lists, in its order', async () => {
    const skill = (name: string) =>
      `---\nname: ${name}\ndescription: Does ${name}\n---\nHow to ${name}.\n`;
    const resolved = await resolutions(
      {
        'agents/reviewer/AGENT.md': entry('reviewer', 'codex', 'skills:\n  - notes\n  - lint\n'),
        'skills/lint/SKILL.md': skill('lint'),
        'skills/notes/SKILL.md': skill('notes'),
      },
      READY,
    ).resolveForRun('reviewer');

    expect(resolved).toMatchObject({
      status: 'resolved',
      agent: { commit: COMMIT, skills: ['notes', 'lint'] },
    });
  });

  it('records no skills for a built-in agent named like a folder that lists some', async () => {
    const resolved = await resolutions(
      {
        'agents/default-codex/AGENT.md': entry('default-codex', 'codex', 'skills:\n  - lint\n'),
      },
      READY,
    ).resolveForRun('default-codex');

    expect(resolved).toMatchObject({ agent: { source: 'built_in', skills: [] } });
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
