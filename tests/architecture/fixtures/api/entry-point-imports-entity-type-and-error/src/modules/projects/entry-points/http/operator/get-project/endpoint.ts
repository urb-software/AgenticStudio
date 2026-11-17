import type { ProjectSnapshot } from '../../../../domain/entities/project.js';
import { ProjectNotFoundError } from '../../../../domain/value-objects/project-errors.js';

export const notFound = ProjectNotFoundError;

export function toResponse(project: ProjectSnapshot): { id: string; name: string } {
  return { id: project.id, name: project.name };
}
