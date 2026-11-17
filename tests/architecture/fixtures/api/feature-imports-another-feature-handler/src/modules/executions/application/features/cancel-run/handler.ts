import { GetRunHandler } from '../get-run/handler.js';

export type CancelRunResult = string;

export class CancelRunHandler {
  constructor(private readonly runs: GetRunHandler) {}

  execute(): CancelRunResult {
    return this.runs.execute();
  }
}
