import type { ProjectReader } from '../../ports/project-reader.js';

export type ListProjectsResult = string[];

export class ListProjectsHandler {
  constructor(private readonly reader: ProjectReader) {}

  async execute(): Promise<ListProjectsResult> {
    return this.reader.projectNames();
  }
}
