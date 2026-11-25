import { Inject, Injectable } from '@nestjs/common';
import { PROJECT_KINDS, type ProjectKinds } from '../../../../projects/contracts/index.js';
import { DraftChangedConcurrentlyError } from '../../../domain/errors/agent-draft-errors.js';
import {
  AGENT_DRAFT_REPOSITORY,
  type AgentDraftRepository,
} from '../../../domain/repositories/agent-draft-repository.js';
import { DRAFT_WRITE_ATTEMPTS } from '../../agent-draft-reader.js';

export interface DiscardAgentDraftForDisconnectInput {
  projectId: string;
}

export type DiscardAgentDraftForDisconnectResult = 'done';

/**
 * When the definitions Repository is disconnected its Clone goes, and a Draft based on a commit of
 * that Clone has no base any more: the Draft is discarded. Any other Project leaves it alone. It
 * is idempotent, so a retried Disconnect runs it again.
 */
@Injectable()
export class DiscardAgentDraftForDisconnectHandler {
  constructor(
    @Inject(PROJECT_KINDS) private readonly kinds: ProjectKinds,
    @Inject(AGENT_DRAFT_REPOSITORY) private readonly drafts: AgentDraftRepository,
  ) {}

  /** Throws `DraftChangedConcurrentlyError` when every attempt lost a race: the step is retried. */
  async execute(
    input: DiscardAgentDraftForDisconnectInput,
  ): Promise<DiscardAgentDraftForDisconnectResult> {
    if ((await this.kinds.kindOf(input.projectId)) !== 'definitions') return 'done';
    for (let attempt = 1; ; attempt += 1) {
      const draft = await this.drafts.find();
      if (draft.files.length === 0) return 'done';
      draft.discard(new Date());
      try {
        await this.drafts.save(draft, new Map());
      } catch (error) {
        if (error instanceof DraftChangedConcurrentlyError && attempt < DRAFT_WRITE_ATTEMPTS) {
          continue;
        }
        throw error;
      }
      return 'done';
    }
  }
}
