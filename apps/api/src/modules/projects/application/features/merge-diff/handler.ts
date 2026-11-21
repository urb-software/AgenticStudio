import { Inject, Injectable } from '@nestjs/common';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import {
  GitCloneMissingError,
  GitOperationError,
  GitRequestRejectedError,
  GitUnsupportedPlatformError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';

export interface MergeDiffInput {
  projectId: string;
  runCommit: string;
  integrationCommit: string;
  limits: { filesMax: number; filePatchMaxBytes: number; patchMaxBytes: number };
}

export interface MergeDiffFile {
  path: string;
  previousPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary?: true;
  patch?: string;
  cut: boolean;
}

export type MergeDiffResult =
  | { status: 'computed'; files: MergeDiffFile[]; truncated: boolean }
  | { status: 'conflicting' }
  | { status: 'repository_not_ready' | 'unsupported_platform' | 'failed'; detail?: string };

/** Needs the commits a review fetch put in the Clone. Every Git failure is an answer. */
@Injectable()
export class MergeDiffHandler {
  constructor(@Inject(REPOSITORY_GIT) private readonly git: RepositoryGit) {}

  async execute(input: MergeDiffInput): Promise<MergeDiffResult> {
    const { projectId, runCommit, integrationCommit, limits } = input;
    if (!isProjectId(projectId)) return { status: 'repository_not_ready' };
    try {
      return await this.git.mergeDiff(projectId, runCommit, integrationCommit, limits);
    } catch (error) {
      if (error instanceof GitUnsupportedPlatformError) return { status: 'unsupported_platform' };
      if (error instanceof GitCloneMissingError) return { status: 'repository_not_ready' };
      if (error instanceof GitOperationError) {
        return { status: 'failed', detail: error.detail || error.reason };
      }
      if (error instanceof GitRequestRejectedError) {
        return { status: 'failed', detail: error.message };
      }
      throw error;
    }
  }
}
