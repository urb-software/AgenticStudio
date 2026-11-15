import type { Provider } from '@agentic-studio/contracts';
import type { ProviderGate } from './provider-gate.js';
import type { ResumeRunStepInput, Runner, RunStep, StartRunStepInput } from './runner.js';

/**
 * The runner dispatcher (Issue #101): picks the Run's provider runner and checks the provider
 * gate immediately before every Run step, first or resumed, in every runner mode (so
 * `provider_disabled` also happens with the fake runner). The spawn boundary checks again
 * before any CLI process is created. Throws {@link ProviderDisabledError} from the step.
 */
export class RunnerDispatcher implements Runner {
  constructor(
    private readonly gate: ProviderGate,
    private readonly runners: Readonly<Record<Provider, Runner>>,
  ) {}

  async *start(input: StartRunStepInput): RunStep {
    return yield* this.runnerFor(input.run.provider).start(input);
  }

  async *resume(input: ResumeRunStepInput): RunStep {
    return yield* this.runnerFor(input.run.provider).resume(input);
  }

  private runnerFor(provider: Provider): Runner {
    this.gate.assertEnabled(provider);
    return this.runners[provider];
  }
}
