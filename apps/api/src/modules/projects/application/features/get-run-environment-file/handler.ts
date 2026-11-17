import type { EnvironmentFile } from '@agentic-studio/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { RunEnvironmentFiles } from '../../../contracts/index.js';
import { isProjectId } from '../../../domain/value-objects/project.js';
import {
  ENVIRONMENT_FILE_REPOSITORY,
  type EnvironmentFileRepository,
} from '../../../domain/repositories/environment-file-repository.js';
import {
  ENVIRONMENT_FILE_CONTENTS,
  type EnvironmentFileContents,
} from '../../ports/environment-file-contents.js';

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
    @Inject(ENVIRONMENT_FILE_CONTENTS) private readonly contents: EnvironmentFileContents,
  ) {}

  async forProject(projectId: string): Promise<EnvironmentFile | null> {
    if (!isProjectId(projectId)) return null;
    // Twice at most: a content replaced between reading the row and the content is read again
    // from the new row.
    for (let attempt = 0; attempt < 2; attempt++) {
      const file = await this.files.find(projectId);
      if (!file) return null;
      const content = await this.contents.read(file.secretRef);
      if (content !== null) return { path: file.path, content };
    }
    throw new Error("The project's Environment file content is missing.");
  }
}
