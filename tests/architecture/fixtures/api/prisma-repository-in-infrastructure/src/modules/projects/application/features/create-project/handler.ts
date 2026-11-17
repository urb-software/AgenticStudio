import { Inject, Injectable } from '@nestjs/common';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';

export type CreateProjectInput = string;

@Injectable()
export class CreateProjectHandler {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  async execute(name: CreateProjectInput): Promise<void> {
    await this.projects.add(name);
  }
}
