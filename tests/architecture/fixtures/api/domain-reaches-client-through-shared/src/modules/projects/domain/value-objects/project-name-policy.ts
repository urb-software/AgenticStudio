import { Queue } from '../../../../shared/clients.js';

export class ProjectNamePolicy {
  constructor(private readonly queue: Queue) {}

  normalize(name: string): string {
    return `${this.queue.name}:${name.trim().toLowerCase()}`;
  }
}
