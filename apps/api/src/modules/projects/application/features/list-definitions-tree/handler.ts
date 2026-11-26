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
  GitCommitMissingError,
  GitOperationError,
  GitRequestRejectedError,
  GitUnsupportedPlatformError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';

export interface ListDefinitionsTreeInput {
  commit: string;
  /** The whole tree instead of the `agents/` folder. */
  whole?: boolean;
  /** Another folder than `agents/`, such as `skills`; ignored with `whole`. */
  directory?: 'agents' | 'skills';
}

export type ListDefinitionsTreeResult = DefinitionsTreeResult;

/**
 * Lists what is tracked under `agents/` (or another folder, or all of it) of the definitions Project's Clone at a commit, from Git's
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
        input.whole ? '' : (input.directory ?? AGENTS_DIRECTORY),
        DEFINITIONS_TREE_MAX_ENTRIES,
      );
      return { status: 'listed', entries: tree.entries, truncated: tree.truncated };
    } catch (error) {
      if (error instanceof GitUnsupportedPlatformError) return { status: 'unsupported_platform' };
      if (error instanceof GitCloneMissingError) return { status: 'repository_not_ready' };
      if (error instanceof GitCommitMissingError) return { status: 'commit_missing' };
      if (error instanceof GitOperationError || error instanceof GitRequestRejectedError) {
        return { status: 'failed' };
      }
      throw error;
    }
  }
}
