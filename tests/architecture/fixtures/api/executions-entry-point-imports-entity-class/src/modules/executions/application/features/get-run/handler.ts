import type { RunView } from '../../../domain/entities/run.js';

export interface GetRunInput {
  runId: string;
}

export interface GetRunResult {
  run: RunView;
}

export class GetRunHandler {
  async execute(input: GetRunInput): Promise<GetRunResult> {
    return { run: { id: input.runId, state: 'queued' } };
  }
}
