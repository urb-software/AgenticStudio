import { Project } from '../../../../domain/entities/project.js';

export function toResponse(project: Project): { id: string; name: string } {
  return { id: project.id, name: project.name };
}
