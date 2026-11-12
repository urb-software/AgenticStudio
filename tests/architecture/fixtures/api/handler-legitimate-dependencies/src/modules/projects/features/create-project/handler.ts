import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../../platform/config/config.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';

@Injectable()
export class CreateProjectHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async execute(name: string): Promise<void> {
    if ((await this.projects.count()) >= this.config.maxProjects) {
      throw new Error('Too many projects');
    }
    await this.projects.add(name);
  }
}
