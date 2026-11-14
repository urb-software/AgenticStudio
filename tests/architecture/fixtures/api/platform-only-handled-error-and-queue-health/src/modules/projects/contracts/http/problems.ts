import { ProblemException, serviceUnavailable } from '../../../../platform/http/problem-details.js';

// Allowed: a business module answers a handled 503 through the generic ProblemException.
export function queueUnavailable(): ProblemException {
  return serviceUnavailable();
}
