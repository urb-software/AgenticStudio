'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { ApiError } from '../api';

/** Retry only what may succeed later: network failures and 5xx, never a 4xx such as 401. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < 2;
}

/**
 * TanStack Query for API (server) state (frontend.md §4). One client per browser tab,
 * created on mount, so no cache is shared between server-rendered requests.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: shouldRetry }, mutations: { retry: false } },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
