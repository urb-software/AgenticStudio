import { PROVIDERS, type Provider } from './provider.js';

export const RUN_AGENT_SOURCES = ['built_in', 'definitions'] as const;
export type RunAgentSource = (typeof RUN_AGENT_SOURCES)[number];

/** What a Run records of its agent when it starts. */
export interface RunAgentData {
  name: string;
  source: RunAgentSource;
  /** The definitions Repository's commit the agent was read at; `null` for a built-in agent. */
  commit: string | null;
  provider: Provider;
  /** The model the definition named; `default` is the CLI's own. */
  model: string;
  /** A copy of the definition's instructions; empty for a built-in agent. */
  instructions: string;
}

/**
 * The agent a Run started with, copied at start and never changed: later edits or removal of the
 * definition do not reach the Run. Treated like the Task: never logged in full.
 */
export class RunAgent {
  readonly name: string;
  readonly source: RunAgentSource;
  readonly commit: string | null;
  readonly provider: Provider;
  readonly model: string;
  readonly instructions: string;

  private constructor(data: RunAgentData) {
    this.name = data.name;
    this.source = data.source;
    this.commit = data.commit;
    this.provider = data.provider;
    this.model = data.model;
    this.instructions = data.instructions;
  }

  /** Throws {@link TypeError} for a record the store should never hold. */
  static restore(data: RunAgentData): RunAgent {
    if (data.name === '') throw new TypeError('A Run agent has a name.');
    if (!(RUN_AGENT_SOURCES as readonly string[]).includes(data.source)) {
      throw new TypeError(`Unknown agent source: ${data.source}`);
    }
    if (!(PROVIDERS as readonly string[]).includes(data.provider)) {
      throw new TypeError(`Unknown provider: ${data.provider}`);
    }
    if ((data.source === 'definitions') !== (data.commit !== null)) {
      throw new TypeError('A definitions agent records a commit, a built-in agent none.');
    }
    return new RunAgent(data);
  }

  toData(): RunAgentData {
    return {
      name: this.name,
      source: this.source,
      commit: this.commit,
      provider: this.provider,
      model: this.model,
      instructions: this.instructions,
    };
  }
}
