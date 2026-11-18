import type { ProjectResponse } from '../../../../../projects/entry-points/http/shared/project-response.js';

export const runIds = (project: ProjectResponse): string[] => [project.id];
