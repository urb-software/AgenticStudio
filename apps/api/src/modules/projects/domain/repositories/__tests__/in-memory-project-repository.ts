import { Project } from '../../entities/project.js';
import type { ProjectName } from '../../value-objects/project-name.js';
import type { ProjectRepository } from '../project-repository.js';

export class InMemoryProjectRepository implements ProjectRepository {
  readonly projects = new Map<string, Project>();

  addProject(id: string, name: string): Project {
    const project = Project.restore({
      id,
      name,
      mergeMethod: 'squash',
      createdAt: new Date('2026-11-13T10:00:00.000Z'),
    });
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

  saveMergeMethod(project: Project): Promise<boolean> {
    if (!this.projects.has(project.id)) return Promise.resolve(false);
    this.projects.set(project.id, project);
    return Promise.resolve(true);
  }
}
