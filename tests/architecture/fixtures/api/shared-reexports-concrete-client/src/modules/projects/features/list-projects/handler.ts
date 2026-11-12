import { Redis } from '../../../../shared/clients.js';

export class ListProjectsHandler {
  constructor(private readonly redis: Redis) {}

  async execute(): Promise<string[]> {
    return this.redis.smembers('projects');
  }
}
