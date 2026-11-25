import { Inject, Injectable } from '@nestjs/common';
import { AgentDraftReader, type AgentDraftView } from '../../agent-draft-reader.js';
import {
  AGENT_DRAFT_REPOSITORY,
  type AgentDraftRepository,
} from '../../../domain/repositories/agent-draft-repository.js';

export type GetAgentDraftResult = AgentDraftView;

/** The Draft of the definitions Repository, with the problems it would make and what moved upstream. */
@Injectable()
export class GetAgentDraftHandler {
  constructor(
    @Inject(AGENT_DRAFT_REPOSITORY) private readonly drafts: AgentDraftRepository,
    private readonly reader: AgentDraftReader,
  ) {}

  async execute(): Promise<GetAgentDraftResult> {
    return this.reader.read(await this.drafts.find());
  }
}
