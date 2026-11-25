import { Injectable } from '@nestjs/common';
import type { DefinitionsRepositories, DefinitionsRepositoryState } from '../../contracts/index.js';
import { GetDefinitionsRepositoryStateHandler } from '../../application/features/get-definitions-repository-state/handler.js';

/**
 * The driving adapter of {@link DefinitionsRepositories}: it maps the call to the handler and holds
 * no rule.
 */
@Injectable()
export class ProjectDefinitionsRepositories implements DefinitionsRepositories {
  constructor(private readonly handler: GetDefinitionsRepositoryStateHandler) {}

  current(): Promise<DefinitionsRepositoryState | null> {
    return this.handler.execute();
  }
}
