import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Platform-only marker for an unlogged generic 503 whose cause is already logged (queue down).
 * It refuses any other status so it cannot hide a different 5xx; modules use
 * `serviceUnavailable()`. The import rule does not stop an unlogged 5xx `ProblemException`.
 */
export class HandledServerErrorException extends HttpException {
  constructor(status: typeof HttpStatus.SERVICE_UNAVAILABLE = HttpStatus.SERVICE_UNAVAILABLE) {
    super('Handled server error', onlyServiceUnavailable(status));
  }
}

function onlyServiceUnavailable(status: number): number {
  if (status !== HttpStatus.SERVICE_UNAVAILABLE) {
    throw new Error(`HandledServerErrorException is 503 only, not ${status}.`);
  }
  return status;
}
