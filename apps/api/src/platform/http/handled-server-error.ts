import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Platform-only marker for an unlogged 503: the health endpoint's answer when the job queue
 * is down, whose cause the queue already logs. The response stays generic like every 5xx,
 * but the filter does not log it as an unhandled error. It refuses any other status, so this
 * marker cannot hide a different 5xx. Business modules use `serviceUnavailable()` from
 * `problem-details.ts` instead and cannot import this file (architecture:api
 * `api-handled-server-error-platform-only`). That rule keeps the marker out of modules; it
 * does not stop a module from throwing an unlogged 5xx `ProblemException`.
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
