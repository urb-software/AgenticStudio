import { Inject, Injectable } from '@nestjs/common';
import {
  GitUnsupportedPlatformError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';

export type GetReviewSupportInput = Record<string, never>;

export interface GetReviewSupportResult {
  supported: boolean;
}

/** Reviews run Git, which works on Linux only. */
@Injectable()
export class GetReviewSupportHandler {
  constructor(@Inject(REPOSITORY_GIT) private readonly git: RepositoryGit) {}

  execute(input: GetReviewSupportInput): GetReviewSupportResult {
    void input;
    try {
      this.git.assertSupported();
      return { supported: true };
    } catch (error) {
      if (error instanceof GitUnsupportedPlatformError) return { supported: false };
      throw error;
    }
  }
}
