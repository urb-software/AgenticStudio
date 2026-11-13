import { listProjects } from '@agentic-studio/missing';

export class ListProjectsHandler {
  execute(): Promise<string[]> {
    return listProjects();
  }
}
