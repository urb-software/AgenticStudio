import type { RunSnapshot } from '../../../domain/entities/run.js';

export interface GetRunInput {
  runId: string;
}

export interface GetRunResult {
  run: RunSnapshot;
}

export class GetRunHandler {
  async execute(input: GetRunInput): Promise<GetRunResult> {
    return { run: { id: input.runId, state: 'queued' } };
  }
}
