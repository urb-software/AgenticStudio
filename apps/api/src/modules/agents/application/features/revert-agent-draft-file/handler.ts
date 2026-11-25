import { Inject, Injectable } from '@nestjs/common';
import { DraftChangedConcurrentlyError } from '../../../domain/errors/agent-draft-errors.js';
import {
  AGENT_DRAFT_REPOSITORY,
  type AgentDraftRepository,
} from '../../../domain/repositories/agent-draft-repository.js';
import {
  AgentDraftReader,
  DRAFT_WRITE_ATTEMPTS,
  type AgentDraftView,
} from '../../agent-draft-reader.js';

export interface RevertAgentDraftFileInput {
  path: string;
}

export type RevertAgentDraftFileResult = AgentDraftView;

/**
 * Drops the Draft's change at a path, so the file is as the base commit has it. For a moved file
 * the new path goes and the original comes back. It reads nothing from the Repository.
 */
@Injectable()
export class RevertAgentDraftFileHandler {
  constructor(
    @Inject(AGENT_DRAFT_REPOSITORY) private readonly drafts: AgentDraftRepository,
    private readonly reader: AgentDraftReader,
  ) {}

  /**
   * Throws `InvalidAgentDraftPathError`, `DraftFileNotFoundError` for a path the Draft does not
   * change, and `DraftChangedConcurrentlyError` when every attempt lost a race.
   */
  async execute(input: RevertAgentDraftFileInput): Promise<RevertAgentDraftFileResult> {
    for (let attempt = 1; ; attempt += 1) {
      const draft = await this.drafts.find();
      draft.revert({ path: input.path, now: new Date() });
      try {
        await this.drafts.save(draft, new Map());
      } catch (error) {
        if (error instanceof DraftChangedConcurrentlyError && attempt < DRAFT_WRITE_ATTEMPTS) {
          continue;
        }
        throw error;
      }
      return this.reader.read(draft);
    }
  }
}
