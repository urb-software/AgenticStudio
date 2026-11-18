import { Redis } from '../../../../../shared/clients.js';

export type ListProjectsResult = string[];

export class ListProjectsHandler {
  constructor(private readonly redis: Redis) {}

  async execute(): Promise<ListProjectsResult> {
    return this.redis.smembers('projects');
  }
}
