'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../../platform/api';
import { LogoutButton } from '../logout/logout-button';

/**
 * Asks the API whether the operator is signed in. Without a session the API answers
 * 401 and the API client sends the browser to the login page; the API, not this
 * component, is what enforces authorization.
 */
export function SessionStatus() {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let active = true;
    api.getSession().then(
      () => active && setSignedIn(true),
      () => active && setSignedIn(false),
    );
    return () => {
      active = false;
    };
  }, []);

  if (!signedIn) {
    return <p>Checking session…</p>;
  }
  return (
    <p>
      Signed in as the operator. <LogoutButton />
    </p>
  );
}
