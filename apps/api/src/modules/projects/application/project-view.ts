import type { Project } from '../domain/entities/project.js';

/** A Project as the queries and commands that show one report it. */
export interface ProjectView {
  id: string;
  /** Display name: normalized, case preserved. */
  name: string;
  createdAt: Date;
}

export function projectView(project: Project): ProjectView {
  return { id: project.id, name: project.name, createdAt: new Date(project.createdAt) };
}
