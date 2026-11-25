import { Inject, Injectable } from '@nestjs/common';
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

export type DiscardAgentDraftResult = AgentDraftView;

/** Drops every change of the Draft; it needs no read of the Repository. */
@Injectable()
export class DiscardAgentDraftHandler {
  constructor(
    @Inject(AGENT_DRAFT_REPOSITORY) private readonly drafts: AgentDraftRepository,
    private readonly reader: AgentDraftReader,
  ) {}

  /** Throws `DraftChangedConcurrentlyError` when every attempt lost a race. */
  async execute(): Promise<DiscardAgentDraftResult> {
    for (let attempt = 1; ; attempt += 1) {
      const draft = await this.drafts.find();
      draft.discard(new Date());
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
