import { getJson } from '@/platform/api/client';

export function listProjects(): Promise<unknown> {
  return getJson('/projects');
}
