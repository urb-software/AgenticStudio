import { Injectable } from '@nestjs/common';
import type { AgentResolution, AgentResolutions } from '../../contracts/index.js';
import { ReadAgentsHandler } from '../../application/features/read-agents/handler.js';

/**
 * The driving adapter of {@link AgentResolutions}: the one-agent read of the agents list, mapped to
 * the answer. A built-in agent comes first in that read, so a folder with a built-in agent's
 * name never answers for it.
 */
@Injectable()
export class ReadAgentsAgentResolutions implements AgentResolutions {
  constructor(private readonly read: ReadAgentsHandler) {}

  async resolveForRun(name: string): Promise<AgentResolution> {
    const { commit, agents } = await this.read.execute({ name });
    const agent = agents[0];
    if (!agent) return { status: 'unknown' };
    if (!agent.usable || agent.provider === null || agent.model === null) {
      return { status: 'not_usable' };
    }
    return {
      status: 'resolved',
      agent: {
        name: agent.name,
        source: agent.source,
        commit: agent.source === 'definitions' ? commit : null,
        provider: agent.provider,
        model: agent.model,
        instructions: agent.instructions,
      },
    };
  }
}
