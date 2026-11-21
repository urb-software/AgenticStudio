import type { Project } from '../domain/entities/project.js';
import type { MergeMethod } from '../domain/value-objects/merge-method.js';

/** A Project as the queries and commands that show one report it. */
export interface ProjectView {
  id: string;
  /** Display name: normalized, case preserved. */
  name: string;
  mergeMethod: MergeMethod;
  createdAt: Date;
}

export function projectView(project: Project): ProjectView {
  return {
    id: project.id,
    name: project.name,
    mergeMethod: project.mergeMethod,
    createdAt: new Date(project.createdAt),
  };
}
