export class InvalidAgentNameError extends Error {
  constructor() {
    super('An agent name is lower-case letters, digits and "-", up to 64 characters.');
    this.name = 'InvalidAgentNameError';
  }
}

/**
 * The name of an agent as the definitions Repository spells it. Only the syntax is judged here:
 * whether an agent of this name exists or is usable is `agents`' to say, where it is read.
 */
export class AgentName {
  /** Pinned to the agent definitions package's pattern by a test. */
  static readonly PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

  private constructor(readonly value: string) {}

  static of(raw: string): AgentName {
    if (!AgentName.PATTERN.test(raw)) throw new InvalidAgentNameError();
    return new AgentName(raw);
  }
}
