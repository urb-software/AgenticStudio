import { PROVIDER_NAMES, type Provider } from '@agentic-studio/contracts';
import { AgentFailedError, type Runner, type RunStep } from './runner.js';

/**
 * The `cli` runner mode's stand-in for a provider whose CLI runner does not exist yet (Claude
 * Code: #105, Codex: #106). It sits behind the dispatcher, so a disabled provider still fails
 * with `provider_disabled` first; an enabled one fails with a clear `agent_failed` and nothing
 * is started. Each real runner replaces it and starts its CLI through `spawnProviderCli`.
 */
export class MissingCliRunner implements Runner {
  constructor(private readonly provider: Provider) {}

  async *start(): RunStep {
    return yield* this.refuse();
  }

  async *resume(): RunStep {
    return yield* this.refuse();
  }

  private async *refuse(): RunStep {
    const name = PROVIDER_NAMES[this.provider];
    yield { type: 'message', text: `no ${name} runner in this agent worker version` };
    throw new AgentFailedError(
      `This version of the agent worker cannot run ${name} yet: its CLI runner is not built.`,
    );
  }
}
