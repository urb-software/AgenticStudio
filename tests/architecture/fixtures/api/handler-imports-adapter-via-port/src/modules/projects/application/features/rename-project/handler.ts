import { ProjectReader } from '../../ports/project-reader.js';

export type RenameProjectInput = string;
export type RenameProjectResult = string;

export class RenameProjectHandler {
  constructor(private readonly reader: ProjectReader) {}

  async execute(projectId: RenameProjectInput): Promise<RenameProjectResult> {
    return this.reader.findName(projectId);
  }
}
