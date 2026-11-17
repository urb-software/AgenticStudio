import { listProjects } from '@agentic-studio/missing';

export type ListProjectsResult = string[];

export class ListProjectsHandler {
  execute(): Promise<ListProjectsResult> {
    return listProjects();
  }
}
