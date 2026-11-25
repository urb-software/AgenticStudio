import type { Project } from '../domain/entities/project.js';
import type { MergeMethod } from '../domain/value-objects/merge-method.js';
import type { ProjectKind } from '../domain/value-objects/project-kind.js';

/** A Project as the queries and commands that show one report it. */
export interface ProjectView {
  id: string;
  /** Display name: normalized, case preserved. */
  name: string;
  mergeMethod: MergeMethod;
  kind: ProjectKind;
  createdAt: Date;
}

export function projectView(project: Project): ProjectView {
  return {
    id: project.id,
    name: project.name,
    mergeMethod: project.mergeMethod,
    kind: project.kind,
    createdAt: new Date(project.createdAt),
  };
}
