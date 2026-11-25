import { Project } from '../../entities/project.js';
import type { ProjectKind } from '../../value-objects/project-kind.js';
import type { ProjectName } from '../../value-objects/project-name.js';
import type { ProjectRepository } from '../project-repository.js';

export class InMemoryProjectRepository implements ProjectRepository {
  readonly projects = new Map<string, Project>();

  addProject(id: string, name: string, kind: ProjectKind = 'code'): Project {
    const project = Project.restore({
      id,
      name,
      mergeMethod: 'squash',
      kind,
      defaultAgent: null,
      createdAt: new Date('2026-11-13T10:00:00.000Z'),
    });
    this.projects.set(id, project);
    return project;
  }

  add(name: ProjectName, kind: ProjectKind): Promise<Project> {
    void name;
    void kind;
    return Promise.reject(new Error('not used by these tests'));
  }

  listNewestFirst(): Promise<Project[]> {
    return Promise.resolve([...this.projects.values()]);
  }

  findById(id: string): Promise<Project | null> {
    return Promise.resolve(this.projects.get(id) ?? null);
  }

  findDefinitions(): Promise<Project | null> {
    return Promise.resolve(
      [...this.projects.values()].find((project) => project.kind === 'definitions') ?? null,
    );
  }

  findByIds(ids: readonly string[]): Promise<Project[]> {
    return Promise.resolve(
      ids.flatMap((id) => {
        const project = this.projects.get(id);
        return project ? [project] : [];
      }),
    );
  }

  saveMergeMethod(project: Project): Promise<boolean> {
    if (!this.projects.has(project.id)) return Promise.resolve(false);
    this.projects.set(project.id, project);
    return Promise.resolve(true);
  }

  saveDefaultAgent(project: Project): Promise<boolean> {
    if (!this.projects.has(project.id)) return Promise.resolve(false);
    this.projects.set(project.id, project);
    return Promise.resolve(true);
  }
}
