import type {
  RepositoryDisconnectStep,
  RepositoryDisconnectSteps,
} from '../../../contracts/index.js';

/** The steps other modules added, held in a list a test fills. */
export class InMemoryDisconnectSteps implements RepositoryDisconnectSteps {
  private readonly steps: RepositoryDisconnectStep[] = [];

  add(step: RepositoryDisconnectStep): void {
    this.steps.push(step);
  }

  list(): readonly RepositoryDisconnectStep[] {
    return this.steps;
  }
}
