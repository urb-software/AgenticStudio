import { Inject, Injectable } from '@nestjs/common';
import { AgentDraftBaseReader } from '../../agent-draft-base.js';
import { AgentDraftReader, type AgentDraftView } from '../../agent-draft-reader.js';
import {
  AGENT_DRAFT_REPOSITORY,
  type AgentDraftRepository,
} from '../../../domain/repositories/agent-draft-repository.js';

export interface DeleteAgentDraftFileInput {
  path: string;
}

export type DeleteAgentDraftFileResult = AgentDraftView;

/**
 * Drops the Draft's change at a path (an added file goes, a modified one reverts, a deleted one
 * comes back), or else marks the file of the base commit deleted.
 */
@Injectable()
export class DeleteAgentDraftFileHandler {
  constructor(
    @Inject(AGENT_DRAFT_REPOSITORY) private readonly drafts: AgentDraftRepository,
    private readonly base: AgentDraftBaseReader,
    private readonly reader: AgentDraftReader,
  ) {}

  /**
   * Throws `InvalidAgentDraftPathError`, `DraftFileNotFoundError`, `DraftPathNotWritableError`,
   * `DraftNoBaseError`, `DraftBaseUnreadableError` and `DraftTooManyFilesError`.
   */
  async execute(input: DeleteAgentDraftFileInput): Promise<DeleteAgentDraftFileResult> {
    const draft = await this.drafts.find();
    const base = await this.base.read(draft.baseCommit);
    draft.delete({
      path: input.path,
      currentCommit: base.currentCommit,
      baseEntries: base.entries,
      now: new Date(),
    });
    await this.drafts.save(draft, new Map());
    return this.reader.read(draft);
  }
}
