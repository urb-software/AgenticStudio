import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Platform-only: the health endpoint's 503 when the job queue is down, whose cause the queue
 * already logs. The response stays generic like every 5xx, but the filter does not log it as
 * an unhandled error. Restricted to 503 so a real 5xx can never be silenced this way.
 * Business modules use `serviceUnavailable()` from `problem-details.ts` instead; they cannot
 * import this file (architecture:api `api-handled-server-error-platform-only`).
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
