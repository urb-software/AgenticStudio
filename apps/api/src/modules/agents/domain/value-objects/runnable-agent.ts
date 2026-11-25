/** What an agent shows of itself, as far as being startable goes. */
interface AgentFacts {
  name: string;
  description: string | null;
  provider: 'claude_code' | 'codex' | null;
  model: string | null;
  source: 'built_in' | 'definitions';
  usable: boolean;
  instructions: string;
}

/**
 * An agent a Run can start with: usable, with its Provider and model known. The one rule for what a
 * Run offers and what a start accepts.
 */
export class RunnableAgent {
  private constructor(
    readonly name: string,
    readonly description: string,
    readonly provider: 'claude_code' | 'codex',
    readonly model: string,
    readonly source: 'built_in' | 'definitions',
    readonly instructions: string,
  ) {}

  /** `null` for an agent that cannot start a Run. */
  static from(agent: AgentFacts): RunnableAgent | null {
    if (!agent.usable || agent.provider === null || agent.model === null) return null;
    return new RunnableAgent(
      agent.name,
      agent.description ?? '',
      agent.provider,
      agent.model,
      agent.source,
      agent.instructions,
    );
  }
}
