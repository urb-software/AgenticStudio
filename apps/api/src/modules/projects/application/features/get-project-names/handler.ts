import { Inject, Injectable } from '@nestjs/common';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';

export interface GetProjectNamesInput {
  ids: readonly string[];
}

/** The names by id; an id of no project has no entry. */
export type GetProjectNamesResult = ReadonlyMap<string, string>;

@Injectable()
export class GetProjectNamesHandler {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  async execute(input: GetProjectNamesInput): Promise<GetProjectNamesResult> {
    const found = await this.projects.findByIds(input.ids);
    return new Map(found.map((project) => [project.id, project.name]));
  }
}
