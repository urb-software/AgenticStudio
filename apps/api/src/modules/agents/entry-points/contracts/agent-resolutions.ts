import { Injectable } from '@nestjs/common';
import type { AgentResolution, AgentResolutions } from '../../contracts/index.js';
import { isRunnable, RunnableAgent } from '../../domain/value-objects/runnable-agent.js';
import {
  type AgentView,
  ReadAgentsHandler,
} from '../../application/features/read-agents/handler.js';

/**
 * The driving adapter of {@link AgentResolutions}: the one-agent read of the agents list, mapped to
 * the answer. A built-in agent comes first in that read, so a folder with a built-in agent's
 * name never answers for it.
 */
@Injectable()
export class ReadAgentsAgentResolutions implements AgentResolutions {
  constructor(private readonly read: ReadAgentsHandler) {}

  async resolveForRun(name: string): Promise<AgentResolution> {
    return this.resolved(await this.read.execute({ name }));
  }

  async resolveAt(commit: string, name: string): Promise<AgentResolution> {
    const read = await this.read.execute({ name, atCommit: commit });
    // The Clone could not be read at the commit: the agent cannot be judged, not missing.
    return read.commit === null ? { status: 'not_usable' } : this.resolved(read);
  }

  private resolved({
    commit,
    agents,
  }: {
    commit: string | null;
    agents: AgentView[];
  }): AgentResolution {
    const agent = agents[0];
    if (!agent) return { status: 'unknown' };
    if (!isRunnable(agent)) return { status: 'not_usable' };
    const runnable = RunnableAgent.of(agent);
    return {
      status: 'resolved',
      agent: {
        name: runnable.name,
        source: runnable.source,
        commit: runnable.source === 'definitions' ? commit : null,
        provider: runnable.provider,
        model: runnable.model,
        instructions: runnable.instructions,
        skills: runnable.skills,
      },
    };
  }
}
