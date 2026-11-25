import { Inject, Injectable } from '@nestjs/common';
import { AgentDraftBaseReader } from '../../agent-draft-base.js';
import { AgentDraftReader, type AgentDraftView } from '../../agent-draft-reader.js';
import {
  AGENT_DRAFT_REPOSITORY,
  type AgentDraftRepository,
} from '../../../domain/repositories/agent-draft-repository.js';

export interface SaveAgentDraftFileInput {
  path: string;
  content: Uint8Array;
}

export type SaveAgentDraftFileResult = AgentDraftView;

/**
 * Stores one file's content in the Draft: the last write wins. The change is judged against the
 * Draft's base commit (the current commit for the first change).
 */
@Injectable()
export class SaveAgentDraftFileHandler {
  constructor(
    @Inject(AGENT_DRAFT_REPOSITORY) private readonly drafts: AgentDraftRepository,
    private readonly base: AgentDraftBaseReader,
    private readonly reader: AgentDraftReader,
  ) {}

  /**
   * Throws `InvalidAgentDraftPathError`, `DraftFileTooLargeError`, `DraftPathNotWritableError`,
   * `DraftPathConflictError`, `DraftNoBaseError`, `DraftBaseUnreadableError`,
   * `DraftTooManyFilesError` and `DraftTooLargeError`.
   */
  async execute(input: SaveAgentDraftFileInput): Promise<SaveAgentDraftFileResult> {
    const draft = await this.drafts.find();
    const base = await this.base.read(draft.baseCommit);
    draft.put({
      path: input.path,
      size: input.content.byteLength,
      currentCommit: base.currentCommit,
      baseEntries: base.entries,
      now: new Date(),
    });
    await this.drafts.save(draft, new Map([[input.path, input.content]]));
    return this.reader.read(draft);
  }
}
