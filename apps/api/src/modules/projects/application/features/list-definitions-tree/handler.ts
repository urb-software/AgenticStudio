import { AGENTS_DIRECTORY } from '@agentic-studio/agent-definitions';
import { Inject, Injectable } from '@nestjs/common';
import {
  DEFINITIONS_TREE_MAX_ENTRIES,
  type DefinitionsTreeResult,
} from '../../../contracts/index.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import {
  GitCloneMissingError,
  GitOperationError,
  GitRequestRejectedError,
  GitUnsupportedPlatformError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';

export interface ListDefinitionsTreeInput {
  commit: string;
}

export type ListDefinitionsTreeResult = DefinitionsTreeResult;

/**
 * Lists what is tracked under `agents/` of the definitions Project's Clone at a commit, from Git's
 * object store: no checkout and no working-tree change.
 */
@Injectable()
export class ListDefinitionsTreeHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
  ) {}

  async execute(input: ListDefinitionsTreeInput): Promise<ListDefinitionsTreeResult> {
    const project = await this.projects.findDefinitions();
    if (!project || !(await this.repositories.find(project.id))) {
      return { status: 'repository_not_ready' };
    }
    try {
      const tree = await this.git.listTreeAtCommit(
        project.id,
        input.commit,
        AGENTS_DIRECTORY,
        DEFINITIONS_TREE_MAX_ENTRIES,
      );
      return { status: 'listed', entries: tree.entries, truncated: tree.truncated };
    } catch (error) {
      if (error instanceof GitUnsupportedPlatformError) return { status: 'unsupported_platform' };
      if (error instanceof GitCloneMissingError) return { status: 'repository_not_ready' };
      if (error instanceof GitOperationError || error instanceof GitRequestRejectedError) {
        return { status: 'failed' };
      }
      throw error;
    }
  }
}
