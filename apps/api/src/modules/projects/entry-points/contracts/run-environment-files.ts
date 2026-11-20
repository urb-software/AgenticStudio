import { Injectable } from '@nestjs/common';
import type { EnvironmentFile } from '@agentic-studio/contracts';
import type { RunEnvironmentFiles } from '../../contracts/index.js';
import { GetRunEnvironmentFileHandler } from '../../application/features/get-run-environment-file/handler.js';

/**
 * The driving adapter for the agent worker's Environment file (a secret): reachable only through
 * `RUN_ENVIRONMENT_FILES`, never an operator endpoint. It maps the call to the handler and holds
 * no rule.
 */
@Injectable()
export class ProjectRunEnvironmentFiles implements RunEnvironmentFiles {
  constructor(private readonly handler: GetRunEnvironmentFileHandler) {}

  forProject(projectId: string): Promise<EnvironmentFile | null> {
    return this.handler.execute({ projectId });
  }
}
