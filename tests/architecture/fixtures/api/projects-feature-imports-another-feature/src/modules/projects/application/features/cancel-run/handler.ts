import { GetRunHandler } from '../get-run/handler.js';

export class CancelRunHandler {
  constructor(private readonly runs: GetRunHandler) {}

  execute(): string {
    return this.runs.execute();
  }
}
