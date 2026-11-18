import type { RunSnapshot } from '../../../../domain/entities/run.js';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';
import { GetRunHandler } from '../../../../application/features/get-run/handler.js';

export class GetRunEndpoint {
  constructor(private readonly handler: GetRunHandler) {}

  async get(runId: string): Promise<RunSnapshot> {
    try {
      return (await this.handler.execute({ runId })).run;
    } catch (error) {
      if (error instanceof RunNotFoundError) throw error;
      throw error;
    }
  }
}
