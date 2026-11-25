import { MAX_FILE_BYTES } from '@agentic-studio/agent-definitions';
import { Inject, Injectable } from '@nestjs/common';
import { DEFINITIONS_FILES, type DefinitionsFiles } from '../../../../projects/contracts/index.js';

export interface ReadAgentFileInput {
  /** A safe relative path, which the entry point checks. */
  path: string;
  /** Full commit id; the last fetched commit when omitted. */
  commit?: string;
}

export type AgentFileContent =
  | { kind: 'text'; content: string }
  | { kind: 'binary'; size: number }
  | { kind: 'too_large'; size: number };

/**
 * `not_found`: no regular file at the path (a link, a submodule and a folder are none), or no
 * commit to read. `commit_missing`: the Clone holds no such commit. `unreadable`: the Clone
 * cannot be read here (not Linux, or Git failed).
 */
export type ReadAgentFileResult =
  | { status: 'read'; commit: string; path: string; content: AgentFileContent }
  | { status: 'not_found' | 'commit_missing' | 'unreadable' };

/** What a UTF-8 decoder writes for bytes that are not UTF-8. */
const REPLACEMENT = String.fromCodePoint(0xfffd);

/**
 * One file at a commit, for display only: binary when it holds a NUL byte or a replacement
 * character (the Git read decodes non-UTF-8 bytes to it), not loaded over the file limit.
 */
@Injectable()
export class ReadAgentFileHandler {
  constructor(@Inject(DEFINITIONS_FILES) private readonly definitions: DefinitionsFiles) {}

  async execute(input: ReadAgentFileInput): Promise<ReadAgentFileResult> {
    const commit = input.commit ?? (await this.definitions.snapshot())?.commit ?? null;
    if (commit === null) return { status: 'not_found' };

    const read = await this.definitions.readFiles(commit, [input.path], MAX_FILE_BYTES);
    if (read.status === 'repository_not_ready') return { status: 'not_found' };
    if (read.status === 'commit_missing') return { status: 'commit_missing' };
    if (read.status !== 'read') return { status: 'unreadable' };

    const file = read.files[0];
    if (!file || file.status === 'missing') return { status: 'not_found' };
    const at = { status: 'read' as const, commit, path: input.path };
    if (file.status === 'too_large') {
      return { ...at, content: { kind: 'too_large', size: file.size } };
    }
    const binary = file.text.includes('\u0000') || file.text.includes(REPLACEMENT);
    return {
      ...at,
      content: binary ? { kind: 'binary', size: file.size } : { kind: 'text', content: file.text },
    };
  }
}
