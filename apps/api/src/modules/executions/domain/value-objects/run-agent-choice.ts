import { AgentNotChosenError, AgentProviderMismatchError } from '../errors/run-errors.js';
import type { Provider } from './provider.js';

/**
 * Which agent a start request asks for: the named agent, or, for a request that names only a
 * Provider, that Provider's built-in Default agent.
 */
export class RunAgentChoice {
  private constructor(
    readonly name: string,
    private readonly requestedProvider: Provider | null,
  ) {}

  /** Throws {@link AgentNotChosenError} when the request names neither an agent nor a provider. */
  static of(request: {
    agent?: string | undefined;
    provider?: Provider | undefined;
  }): RunAgentChoice {
    const { agent, provider } = request;
    if (agent !== undefined) return new RunAgentChoice(agent, provider ?? null);
    if (provider === undefined) throw new AgentNotChosenError();
    return new RunAgentChoice(`default-${provider.replaceAll('_', '-')}`, provider);
  }

  /** Throws {@link AgentProviderMismatchError} when a requested provider is not the agent's. */
  assertProvider(agentProvider: Provider): void {
    if (this.requestedProvider !== null && this.requestedProvider !== agentProvider) {
      throw new AgentProviderMismatchError(agentProvider, this.requestedProvider);
    }
  }
}
