import { Injectable } from '@nestjs/common';
import type { RepositoryDisconnectStep, RepositoryDisconnectSteps } from '../../contracts/index.js';

/** The steps other modules added, in the order they were added. */
@Injectable()
export class ProjectRepositoryDisconnectSteps implements RepositoryDisconnectSteps {
  private readonly steps: RepositoryDisconnectStep[] = [];

  add(step: RepositoryDisconnectStep): void {
    this.steps.push(step);
  }

  list(): readonly RepositoryDisconnectStep[] {
    return this.steps;
  }
}
