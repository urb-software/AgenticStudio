import { RunGoneError } from '../get-run/errors.js';

export class CancelRunHandler {
  execute(): never {
    throw new RunGoneError();
  }
}
