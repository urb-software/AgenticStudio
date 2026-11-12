'use client';

import { useState } from 'react';
import { api, LOGIN_PATH } from '../../../../platform/api';

/** Ends the session on the API (Redis + cookie), then shows the login page. */
export function LogoutButton() {
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    try {
      await api.logout();
    } finally {
      // Also when the session had already expired (401): either way it is gone.
      window.location.assign(LOGIN_PATH);
    }
  }

  return (
    <button type="button" onClick={onClick} disabled={pending}>
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
