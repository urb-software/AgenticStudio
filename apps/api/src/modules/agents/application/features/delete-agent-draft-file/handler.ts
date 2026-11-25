import { Inject, Injectable } from '@nestjs/common';
import { AgentDraftBaseReader } from '../../agent-draft-base.js';
import {
  AgentDraftReader,
  DRAFT_WRITE_ATTEMPTS,
  type AgentDraftView,
} from '../../agent-draft-reader.js';
import { DraftChangedConcurrentlyError } from '../../../domain/errors/agent-draft-errors.js';
import {
  AGENT_DRAFT_REPOSITORY,
  type AgentDraftRepository,
} from '../../../domain/repositories/agent-draft-repository.js';

export interface DeleteAgentDraftFileInput {
  path: string;
}

export type DeleteAgentDraftFileResult = AgentDraftView;

/**
 * Marks a path deleted in one step: an added file simply goes, a modified one becomes deleted
 * (its content change is dropped), and a file of the base commit is marked deleted.
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
   * `DraftNoBaseError`, `DraftBaseUnreadableError`, `DraftBaseMissingError`,
   * `DraftTooManyFilesError` and `DraftChangedConcurrentlyError`.
   */
  async execute(input: DeleteAgentDraftFileInput): Promise<DeleteAgentDraftFileResult> {
    for (let attempt = 1; ; attempt += 1) {
      const draft = await this.drafts.find();
      const base = await this.base.read(draft.baseCommit);
      draft.delete({
        path: input.path,
        currentCommit: base.currentCommit,
        baseEntries: base.entries,
        now: new Date(),
      });
      try {
        await this.drafts.save(draft, new Map());
      } catch (error) {
        if (error instanceof DraftChangedConcurrentlyError && attempt < DRAFT_WRITE_ATTEMPTS)
          continue;
        throw error;
      }
      return this.reader.read(draft);
    }
  }
}
