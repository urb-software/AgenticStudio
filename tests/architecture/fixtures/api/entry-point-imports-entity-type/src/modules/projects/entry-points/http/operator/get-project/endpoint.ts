import type { ProjectView } from '../../../../domain/entities/project.js';
import { ProjectNotFoundError } from '../../../../domain/errors/project-errors.js';

export const notFound = ProjectNotFoundError;

export function toResponse(project: ProjectView): { id: string; name: string } {
  return { id: project.id, name: project.name };
}
