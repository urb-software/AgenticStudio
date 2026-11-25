import { MAX_FILE_BYTES } from '@agentic-studio/agent-definitions';
import { Inject, Injectable } from '@nestjs/common';
import { DEFINITIONS_FILES, type DefinitionsFiles } from '../../../../projects/contracts/index.js';
import {
  AGENT_DRAFT_REPOSITORY,
  type AgentDraftRepository,
} from '../../../domain/repositories/agent-draft-repository.js';

export interface ReadAgentDraftFileInput {
  /** A safe relative path, which the entry point checks. */
  path: string;
}

export type AgentDraftFileContent =
  | { kind: 'text'; content: string }
  | { kind: 'binary'; size: number }
  | { kind: 'too_large'; size: number };

/**
 * `not_found`: no regular file at the path as the Draft sees it (a file the Draft deletes is none),
 * or no commit to read. `commit_missing`: the Clone holds no such commit. `unreadable`: the Clone
 * cannot be read here.
 */
export type ReadAgentDraftFileResult =
  | { status: 'read'; commit: string; path: string; content: AgentDraftFileContent }
  | { status: 'not_found' | 'commit_missing' | 'unreadable' };

// Valid UTF-8 without a NUL byte is text, as for a file read from Git.
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function contentOf(bytes: Uint8Array): AgentDraftFileContent {
  if (bytes.includes(0)) return { kind: 'binary', size: bytes.byteLength };
  try {
    return { kind: 'text', content: STRICT_UTF8.decode(bytes) };
  } catch {
    return { kind: 'binary', size: bytes.byteLength };
  }
}

/**
 * One file as the Draft sees it, for display only: the Draft's own content when it adds or
 * modifies the file, and the base commit's otherwise. `commit` is the commit the Draft is based on.
 */
@Injectable()
export class ReadAgentDraftFileHandler {
  constructor(
    @Inject(AGENT_DRAFT_REPOSITORY) private readonly drafts: AgentDraftRepository,
    @Inject(DEFINITIONS_FILES) private readonly definitions: DefinitionsFiles,
  ) {}

  async execute(input: ReadAgentDraftFileInput): Promise<ReadAgentDraftFileResult> {
    const draft = await this.drafts.find();
    const changed = draft.fileAt(input.path);
    if (changed?.isDeleted) return { status: 'not_found' };
    if (changed && draft.baseCommit !== null) {
      const bytes = await this.drafts.findContent(input.path);
      if (!bytes) return { status: 'not_found' };
      return {
        status: 'read',
        commit: draft.baseCommit,
        path: input.path,
        content: contentOf(bytes),
      };
    }

    const commit = draft.baseCommit ?? (await this.definitions.snapshot())?.commit ?? null;
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
    return {
      ...at,
      content: file.binary
        ? { kind: 'binary', size: file.size }
        : { kind: 'text', content: file.text },
    };
  }
}
