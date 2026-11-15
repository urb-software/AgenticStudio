import { ApiError } from '../../../platform/api';

/**
 * A failed request for an error state, in mono: the method and path, then the problem+json status
 * and title (never a body). Without an HTTP answer it is the request alone.
 */
export function failedRequest(request: string, error: unknown): string {
  if (!(error instanceof ApiError) || error.status === 0) return request;
  const status = [error.status, error.problem?.title].filter(Boolean).join(' ');
  return `${request} · ${status}`;
}
