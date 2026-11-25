import { Inject, Injectable } from '@nestjs/common';
import {
  DEFINITIONS_REPOSITORIES,
  type DefinitionsRepositories,
  type RepositoryState,
} from '../../../../projects/contracts/index.js';

export interface GetDefinitionsRepositoryResult {
  /** `null` when no definitions Repository is connected. */
  project: {
    id: string;
    /** `null` while the Project has no Repository connected yet. */
    repository: {
      state: RepositoryState;
      integrationBranch: string;
      /** The last fetched commit; `null` without a usable Clone. */
      headSha: string | null;
      lastFetchedAt: Date | null;
    } | null;
  } | null;
}

/** The definitions Repository's Project and its connection, as `projects` reports them. */
@Injectable()
export class GetDefinitionsRepositoryHandler {
  constructor(
    @Inject(DEFINITIONS_REPOSITORIES) private readonly definitions: DefinitionsRepositories,
  ) {}

  async execute(): Promise<GetDefinitionsRepositoryResult> {
    const current = await this.definitions.current();
    return { project: current ? { id: current.projectId, repository: current.repository } : null };
  }
}
