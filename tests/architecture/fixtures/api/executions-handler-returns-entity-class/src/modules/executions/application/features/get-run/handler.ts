import { Run } from '../../../domain/entities/run.js';

export class GetRunHandler {
  async execute(runId: string): Promise<Run> {
    return Run.restore(runId, 'queued');
  }
}
