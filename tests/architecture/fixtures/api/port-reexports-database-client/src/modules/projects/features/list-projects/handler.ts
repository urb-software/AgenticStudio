import type { ProjectReader } from '../../ports/project-reader.js';

export class ListProjectsHandler {
  constructor(private readonly reader: ProjectReader) {}

  async execute(): Promise<string[]> {
    return this.reader.projectNames();
  }
}
