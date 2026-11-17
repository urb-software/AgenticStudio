import type { GetRunHandler } from '../get-run/handler.js';

export type Source = GetRunHandler;

export class CancelRunHandler {
  execute(): void {}
}
