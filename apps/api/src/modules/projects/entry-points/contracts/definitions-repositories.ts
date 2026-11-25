import { Injectable } from '@nestjs/common';
import type { DefinitionsRepositories, DefinitionsRepositoryState } from '../../contracts/index.js';
import { GetDefinitionsRepositoryHandler } from '../../application/features/get-definitions-repository/handler.js';

/** The driving adapter of {@link DefinitionsRepositories}: it maps the call to the handler and holds no rule. */
@Injectable()
export class ProjectDefinitionsRepositories implements DefinitionsRepositories {
  constructor(private readonly handler: GetDefinitionsRepositoryHandler) {}

  current(): Promise<DefinitionsRepositoryState | null> {
    return this.handler.execute();
  }
}
