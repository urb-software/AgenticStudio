import { MAX_FILE_BYTES } from '@agentic-studio/agent-definitions';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentFileEntry,
  ListAgentFilesHandler,
} from '../../../../../application/features/list-agent-files/handler.js';
import { ListAgentFilesEndpoint } from '../endpoint.js';

const entry = (path: string, kind: AgentFileEntry['kind'], size: number): AgentFileEntry => ({
  path,
  kind,
  size,
  agent: null,
  skill: null,
});

describe('ListAgentFilesEndpoint', () => {
  it('marks which entries the content route can open', async () => {
    const handler = {
      execute: vi.fn(() =>
        Promise.resolve({
          commit: 'a'.repeat(40),
          repository: { state: 'ready' as const, note: null },
          truncated: false,
          entries: [
            entry('README.md', 'file', 3),
            entry('big.txt', 'file', MAX_FILE_BYTES),
            entry('too-big.txt', 'file', MAX_FILE_BYTES + 1),
            entry('link.md', 'symlink', 0),
            entry('vendor/lib', 'submodule', 0),
            entry(`docs/${'a'.repeat(300)}.md`, 'file', 1),
            entry('docs/tab\tname.md', 'file', 1),
          ],
        }),
      ),
    };
    const endpoint = new ListAgentFilesEndpoint(handler as unknown as ListAgentFilesHandler);

    const answer = await endpoint.list();

    expect(answer.entries.map((item) => [item.path.slice(0, 12), item.openable])).toEqual([
      ['README.md', true],
      ['big.txt', true],
      ['too-big.txt', false],
      ['link.md', false],
      ['vendor/lib', false],
      ['docs/aaaaaaa', false],
      ['docs/tab\tnam', false],
    ]);
  });
});
