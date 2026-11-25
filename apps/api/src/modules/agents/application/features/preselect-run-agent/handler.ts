import { Inject, Injectable } from '@nestjs/common';
import {
  PROJECT_DEFAULT_AGENTS,
  type ProjectDefaultAgents,
} from '../../../../projects/contracts/index.js';
import { RunAgentPreselection } from '../../../domain/value-objects/run-agent-preselection.js';

export interface PreselectRunAgentInput {
  projectId: string;
  /** The agents of the list, usable or not. */
  agents: { name: string; usable: boolean }[];
}

export type PreselectRunAgentResult =
  { status: 'chosen'; agent: string; reason: string | null } | { status: 'project_not_found' };

/** Picks the agent a Run of the Project offers first, judging the Project's default where it is read. */
@Injectable()
export class PreselectRunAgentHandler {
  constructor(@Inject(PROJECT_DEFAULT_AGENTS) private readonly defaults: ProjectDefaultAgents) {}

  async execute(input: PreselectRunAgentInput): Promise<PreselectRunAgentResult> {
    const stored = await this.defaults.forProject(input.projectId);
    if (stored.status === 'project_not_found') return stored;
    const chosen = RunAgentPreselection.of(input.agents, stored.agent);
    return { status: 'chosen', agent: chosen.agent, reason: chosen.reason };
  }
}
