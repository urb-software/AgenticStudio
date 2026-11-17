import { ProjectReader } from '../../ports/project-reader.js';

export class RenameProjectHandler {
  constructor(private readonly reader: ProjectReader) {}

  async execute(projectId: string): Promise<string> {
    return this.reader.findName(projectId);
  }
}
