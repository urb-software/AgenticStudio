import type { ProjectRepository } from '../../domain/repositories/missing-repository.js';

export class CreateProjectHandler {
  constructor(private readonly projects: ProjectRepository) {}
}
