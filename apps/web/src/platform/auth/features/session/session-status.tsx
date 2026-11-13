'use client';

import { useEffect, useState } from 'react';
import { ApiError, api } from '../../../api';
import { LogoutButton } from '../logout/logout-button';

type SessionState = 'checking' | 'signed-in' | 'redirecting' | 'unavailable';

/**
 * Asks the API whether the operator is signed in. Without a session the API answers
 * 401 and the API client sends the browser to the login page; the API, not this
 * component, is what enforces authorization.
 */
export function SessionStatus() {
  const [state, setState] = useState<SessionState>('checking');

  useEffect(() => {
    let active = true;
    api.getSession().then(
      () => active && setState('signed-in'),
      (error: unknown) =>
        active &&
        setState(error instanceof ApiError && error.status === 401 ? 'redirecting' : 'unavailable'),
    );
    return () => {
      active = false;
    };
  }, []);

  switch (state) {
    case 'checking':
      return <p>Checking session…</p>;
    case 'redirecting':
      return <p>Not signed in. Redirecting to the login page…</p>;
    case 'unavailable':
      return <p role="alert">Could not check the session. Reload the page to try again.</p>;
    case 'signed-in':
      return (
        <p>
          Signed in as the operator. <LogoutButton />
        </p>
      );
  }
}
