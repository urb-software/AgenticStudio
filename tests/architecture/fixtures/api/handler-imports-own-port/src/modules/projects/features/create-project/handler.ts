import type { ProjectRepository } from '../../domain/repositories/project-repository.js';
import type { Clock } from '../../ports/clock.js';

export class CreateProjectHandler {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly clock: Clock,
  ) {}

  async execute(name: string): Promise<void> {
    await this.projects.add({ name, createdAt: this.clock.now() });
  }
}
