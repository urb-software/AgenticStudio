export interface ProjectReader {
  findName(projectId: string): Promise<string | null>;
}
