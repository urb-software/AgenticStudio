import { Inject, Injectable } from '@nestjs/common';
import {
  PROJECT_DEFAULT_AGENTS,
  type ProjectDefaultAgents,
} from '../../../../projects/contracts/index.js';
import { RunAgentPreselection } from '../../../domain/value-objects/run-agent-preselection.js';
import { isRunnable, RunnableAgent } from '../../../domain/value-objects/runnable-agent.js';
import { type AgentsRead, type AgentView, AgentsReader } from '../../agents-reader.js';
import type { Provider } from '@agentic-studio/agent-definitions';

export { MAX_LISTED_AGENTS } from '../../agents-reader.js';
export type { AgentView } from '../../agents-reader.js';

export interface ReadAgentsInput {
  /** Reads this agent only, wherever it sits among the folders. */
  name?: string;
  /** Also answers the agents a Run of this Project offers, and the one to preselect. */
  projectId?: string;
}

export interface ReadAgentsResult extends AgentsRead {
  /** Only with a `projectId`. */
  forRun?:
    | {
        status: 'offered';
        agents: {
          name: string;
          description: string;
          provider: Provider;
          model: string;
          source: 'built_in' | 'definitions';
        }[];
        preselected: string;
        reason: string | null;
      }
    | { status: 'project_not_found' | 'definitions_project' };
}

/** The agents list and the single agent, and with a Project the agents a Run of it offers. */
@Injectable()
export class ReadAgentsHandler {
  constructor(
    private readonly reader: AgentsReader,
    @Inject(PROJECT_DEFAULT_AGENTS) private readonly defaults: ProjectDefaultAgents,
  ) {}

  async execute(input: ReadAgentsInput = {}): Promise<ReadAgentsResult> {
    const result = await this.reader.read(input.name);
    if (input.projectId === undefined) return result;
    return { ...result, forRun: await this.offeredFor(input.projectId, result.agents) };
  }

  private async offeredFor(
    projectId: string,
    agents: AgentView[],
  ): Promise<NonNullable<ReadAgentsResult['forRun']>> {
    const stored = await this.defaults.forProject(projectId);
    if (stored.status === 'project_not_found') return stored;
    if (stored.kind === 'definitions') return { status: 'definitions_project' };
    const chosen = RunAgentPreselection.of(
      agents.map((agent) => ({ name: agent.name, usable: isRunnable(agent) })),
      stored.agent,
    );
    return {
      status: 'offered',
      agents: agents.filter(isRunnable).map((agent) => {
        const runnable = RunnableAgent.of(agent);
        return {
          name: runnable.name,
          description: runnable.description,
          provider: runnable.provider,
          model: runnable.model,
          source: runnable.source,
        };
      }),
      preselected: chosen.agent,
      reason: chosen.reason,
    };
  }
}
