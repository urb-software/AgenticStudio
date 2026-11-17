import { ListRunsHandler } from '../../../../application/features/list-runs/handler.js';
import { ClockUnavailableError } from '../../../../application/ports/clock.js';
import { RunNotFoundError } from '../../../../domain/repositories/run-repository.js';
import type { RunResponse } from '../../shared/run-response.js';
import type { ListRunsQuery } from './schema.js';

export class ListRunsEndpoint {
  constructor(private readonly handler: ListRunsHandler) {}

  async list(query: ListRunsQuery): Promise<RunResponse[]> {
    try {
      return (await this.handler.execute()).slice(0, query.limit).map((id) => ({ id }));
    } catch (error) {
      if (error instanceof RunNotFoundError || error instanceof ClockUnavailableError) return [];
      throw error;
    }
  }
}
