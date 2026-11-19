import { readFile } from 'node:fs/promises';

export class ProjectView {
  async load(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }
}
