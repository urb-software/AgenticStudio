import { readFile } from 'node:fs/promises';

export class ProjectSnapshot {
  async load(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }
}
