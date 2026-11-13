'use client';

import { useState } from 'react';
import { api, ApiError, LOGIN_PATH } from '../../../api';

/**
 * Ends the session on the API (Redis + cookie), then shows the login page. When the
 * logout fails (403, 5xx, network error) the session may still be valid, so the button
 * says so and stays on the page instead of pretending the operator is signed out.
 */
export function LogoutButton() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function onClick() {
    setPending(true);
    setFailed(false);
    try {
      await api.logout();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // The session had already expired, so it is gone: the API wrapper is already
        // sending the browser to the login page.
        return;
      }
      setFailed(true);
      setPending(false);
      return;
    }
    window.location.assign(LOGIN_PATH);
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        aria-describedby={failed ? 'logout-error' : undefined}
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
      {/* A span: the button sits inside the session status paragraph. */}
      {failed ? (
        <span id="logout-error" role="alert">
          Could not sign out. Your session may still be active. Try again.
        </span>
      ) : null}
    </>
  );
}
