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
   * Throws the path, size, limit and base errors of the entity and the base reader, and
   * `DraftChangedConcurrentlyError` when every attempt lost a race.
   */
  async execute(input: SaveAgentDraftFileInput): Promise<SaveAgentDraftFileResult> {
    for (let attempt = 1; ; attempt += 1) {
      const draft = await this.drafts.find();
      const base = await this.base.read(draft.baseCommit);
      draft.put({
        path: input.path,
        size: input.content.byteLength,
        currentCommit: base.currentCommit,
        baseEntries: base.entries,
        now: new Date(),
      });
      try {
        await this.drafts.save(draft, new Map([[input.path, input.content]]));
      } catch (error) {
        if (error instanceof DraftChangedConcurrentlyError && attempt < DRAFT_WRITE_ATTEMPTS)
          continue;
        throw error;
      }
      return this.reader.read(draft);
    }
  }
}
