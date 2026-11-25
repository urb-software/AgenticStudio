import { Inject, Injectable } from '@nestjs/common';
import { projectView, type ProjectView } from '../../project-view.js';
import { ProjectNotFoundError } from '../../../domain/errors/project-errors.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import { AgentName } from '../../../domain/value-objects/agent-name.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';

export interface SetDefaultAgentInput {
  projectId: string;
  /** `null` clears the default. */
  agent: string | null;
}

export type SetDefaultAgentResult = ProjectView;

/**
 * Names the agent a Run of the Project offers first. Only the name's syntax is judged: usability
 * is judged where the default is read. Throws {@link ProjectNotFoundError},
 * `DefinitionsProjectError` or `InvalidAgentNameError`.
 */
@Injectable()
export class SetDefaultAgentHandler {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  async execute(input: SetDefaultAgentInput): Promise<SetDefaultAgentResult> {
    if (!isProjectId(input.projectId)) throw new ProjectNotFoundError();
    const project = await this.projects.findById(input.projectId);
    if (!project) throw new ProjectNotFoundError();
    const changed = project.withDefaultAgent(
      input.agent === null ? null : AgentName.of(input.agent),
    );
    if (!(await this.projects.saveDefaultAgent(changed))) throw new ProjectNotFoundError();
    return projectView(changed);
  }
}
