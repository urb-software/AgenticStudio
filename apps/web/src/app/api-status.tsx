'use client';

import { useEffect, useState } from 'react';
import { api } from '../platform/api';

type ApiStatusValue = 'checking' | 'ok' | 'unavailable';

/** Shows whether the API answers, through the generated client (placeholder for the Studio shell). */
export function ApiStatus() {
  const [status, setStatus] = useState<ApiStatusValue>('checking');

  useEffect(() => {
    let active = true;
    api.getHealth().then(
      (data) => active && setStatus(data.status === 'ok' ? 'ok' : 'unavailable'),
      () => active && setStatus('unavailable'),
    );
    return () => {
      active = false;
    };
  }, []);

  return <p>API status: {status}</p>;
}
