import { HandledServerErrorException } from '../../../../platform/http/problem-details.js';

export function queueUnavailable(): HandledServerErrorException {
  return new HandledServerErrorException();
}
