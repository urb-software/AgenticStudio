import { spawn } from '../../../../shared/processes.js';

export class ProjectNamePolicy {
  constructor(private readonly start: typeof spawn) {}

  normalize(name: string): string {
    return `${this.start.name}:${name.trim().toLowerCase()}`;
  }
}
