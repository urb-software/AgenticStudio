import { PROJECTS_PATH } from '@/modules/projects';

export function projectsUrl(): string {
  return '/api' + PROJECTS_PATH;
}
