import type { ProjectCache } from '@agentic-studio/cache';

export interface ProjectCaches {
  forProject(projectId: string): ProjectCache;
}
