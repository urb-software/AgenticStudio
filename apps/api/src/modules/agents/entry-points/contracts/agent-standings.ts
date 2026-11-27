import { Injectable } from '@nestjs/common';
import type { AgentStandings, DefinitionAgentStandings } from '../../contracts/index.js';
import { AgentsReader } from '../../application/agents-reader.js';

/** The driving adapter of {@link AgentStandings}: the agents reader's judged list, as is. */
@Injectable()
export class ReadAgentsAgentStandings implements AgentStandings {
  constructor(private readonly agents: AgentsReader) {}

  at(commit: string, names: readonly string[]): Promise<DefinitionAgentStandings> {
    return this.agents.standings(commit, names);
  }
}
