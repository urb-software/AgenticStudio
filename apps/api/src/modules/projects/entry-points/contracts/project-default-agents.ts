import { Injectable } from '@nestjs/common';
import type { ProjectDefaultAgent, ProjectDefaultAgents } from '../../contracts/index.js';
import { GetProjectDefaultAgentHandler } from '../../application/features/get-project-default-agent/handler.js';

/** The driving adapter of {@link ProjectDefaultAgents}: it maps the call to a handler. */
@Injectable()
export class ProjectProjectDefaultAgents implements ProjectDefaultAgents {
  constructor(private readonly handler: GetProjectDefaultAgentHandler) {}

  forProject(projectId: string): Promise<ProjectDefaultAgent> {
    return this.handler.execute({ projectId });
  }
}
