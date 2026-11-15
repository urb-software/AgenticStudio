import { Inject, Injectable } from '@nestjs/common';
import {
  SECRET_STORE,
  SecretNotFoundError,
  type SecretStore,
} from '../../../../platform/secrets/index.js';
import type { RunEnvironmentFile, RunEnvironmentFiles } from '../../contracts/index.js';
import { isProjectId } from '../../domain/entities/project.js';
import {
  ENVIRONMENT_FILE_REPOSITORY,
  type EnvironmentFileRepository,
} from '../../domain/repositories/environment-file-repository.js';

/**
 * Query (Issue #104): the project's Environment file with its content, for `executions` when a
 * Run is claimed (the public {@link RunEnvironmentFiles} contract); `null` when none is set.
 * Never used by an operator endpoint. A content replaced between reading the row and the
 * secret is read again from the new row.
 */
@Injectable()
export class GetRunEnvironmentFileHandler implements RunEnvironmentFiles {
  constructor(
    @Inject(ENVIRONMENT_FILE_REPOSITORY) private readonly files: EnvironmentFileRepository,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
  ) {}

  async forProject(projectId: string): Promise<RunEnvironmentFile | null> {
    if (!isProjectId(projectId)) return null;
    for (let attempt = 0; ; attempt++) {
      const file = await this.files.find(projectId);
      if (!file) return null;
      try {
        return { path: file.path, content: await this.secrets.get(file.secretRef) };
      } catch (error) {
        if (!(error instanceof SecretNotFoundError) || attempt > 0) throw error;
      }
    }
  }
}
