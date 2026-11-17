import { Project } from '../../entities/project.js';
import type { ProjectName } from '../../value-objects/project-name.js';
import type { ProjectRepository } from '../project-repository.js';

/**
 * In-memory adapter of {@link ProjectRepository} for handler tests: the Projects only. The
 * Repository connections of the same projects are in `InMemoryRepositoryConnectionRepository`.
 */
export class InMemoryProjectRepository implements ProjectRepository {
  readonly projects = new Map<string, Project>();

  addProject(id: string, name: string): Project {
    const project = Project.restore({ id, name, createdAt: new Date('2026-11-13T10:00:00.000Z') });
    this.projects.set(id, project);
    return project;
  }

  add(name: ProjectName): Promise<Project> {
    void name;
    return Promise.reject(new Error('not used by these tests'));
  }

  listNewestFirst(): Promise<Project[]> {
    return Promise.resolve([...this.projects.values()]);
  }

  findById(id: string): Promise<Project | null> {
    return Promise.resolve(this.projects.get(id) ?? null);
  }
}
