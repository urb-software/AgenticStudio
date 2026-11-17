export type CancelRunResult = string;

export class CancelRunHandler {
  execute(): CancelRunResult {
    return 'cancelled';
  }
}
