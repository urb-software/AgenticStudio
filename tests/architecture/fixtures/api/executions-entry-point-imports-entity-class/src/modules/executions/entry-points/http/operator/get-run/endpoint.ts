import { Run } from '../../../../domain/entities/run.js';
import { GetRunHandler } from '../../../../application/features/get-run/handler.js';

export class GetRunEndpoint {
  constructor(private readonly handler: GetRunHandler) {}

  async get(runId: string): Promise<string> {
    const { run } = await this.handler.execute({ runId });
    return Run.restore(run.id, run.state).state;
  }
}
