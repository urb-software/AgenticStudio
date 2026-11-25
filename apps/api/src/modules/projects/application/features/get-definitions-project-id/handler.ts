import { Inject, Injectable } from '@nestjs/common';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';

/** The id of the definitions Project, or `null` when none exists. */
export type GetDefinitionsProjectIdResult = string | null;

@Injectable()
export class GetDefinitionsProjectIdHandler {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  async execute(): Promise<GetDefinitionsProjectIdResult> {
    return (await this.projects.findDefinitions())?.id ?? null;
  }
}
