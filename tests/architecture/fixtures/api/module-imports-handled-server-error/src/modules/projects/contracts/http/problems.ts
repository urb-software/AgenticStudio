import { HandledServerErrorException } from '../../../../platform/http/handled-server-error.js';

// Forbidden: a business module silencing a 5xx in the logs; it uses serviceUnavailable().
export function queueUnavailable(): HandledServerErrorException {
  return new HandledServerErrorException();
}
