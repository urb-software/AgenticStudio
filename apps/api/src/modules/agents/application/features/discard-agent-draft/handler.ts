import { Inject, Injectable } from '@nestjs/common';
import { AgentDraftReader, type AgentDraftView } from '../../agent-draft-reader.js';
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

  async execute(): Promise<DiscardAgentDraftResult> {
    const draft = await this.drafts.find();
    draft.discard(new Date());
    await this.drafts.save(draft, new Map());
    return this.reader.read(draft);
  }
}
