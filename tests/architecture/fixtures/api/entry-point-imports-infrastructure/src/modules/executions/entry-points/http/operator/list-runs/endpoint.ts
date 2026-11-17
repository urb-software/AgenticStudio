import { PrismaRunRepository } from '../../../../infrastructure/repositories/prisma-run-repository.js';

export class ListRunsEndpoint {
  constructor(private readonly runs: PrismaRunRepository) {}

  count(): Promise<number> {
    return this.runs.count();
  }
}
