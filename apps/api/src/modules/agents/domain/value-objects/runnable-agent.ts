/** What an agent shows of itself, as far as being startable goes. */
interface AgentFacts {
  name: string;
  description: string | null;
  provider: 'claude_code' | 'codex' | null;
  model: string | null;
  source: 'built_in' | 'definitions';
  usable: boolean;
  instructions: string;
  skills: string[];
}

type RunnableFacts = AgentFacts & {
  usable: true;
  provider: 'claude_code' | 'codex';
  model: string;
};

/** The one rule for what a Run offers and what a start accepts: usable, Provider and model known. */
export function isRunnable<T extends AgentFacts>(agent: T): agent is T & RunnableFacts {
  return agent.usable && agent.provider !== null && agent.model !== null;
}

/** An agent a Run can start with. */
export class RunnableAgent {
  private constructor(
    readonly name: string,
    readonly description: string,
    readonly provider: 'claude_code' | 'codex',
    readonly model: string,
    readonly source: 'built_in' | 'definitions',
    readonly instructions: string,
    readonly skills: string[],
  ) {}

  static of(agent: RunnableFacts): RunnableAgent {
    return new RunnableAgent(
      agent.name,
      agent.description ?? '',
      agent.provider,
      agent.model,
      agent.source,
      agent.instructions,
      [...agent.skills],
    );
  }
}
