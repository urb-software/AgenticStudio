'use client';

import { useQuery } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { api, ApiError, LOGIN_PATH } from '../../../api';

const SESSION_QUERY_KEY = ['auth', 'session'] as const;

const LOGOUT_FAILED = 'Could not log out. Your session may still be active. Try again.';

function sessionLabel(status: 'pending' | 'error' | 'success', error: unknown): string {
  if (status === 'pending') return 'Checking session…';
  if (status === 'success') return 'Signed in';
  // On 401 the API client is already sending the browser to the login page.
  return error instanceof ApiError && error.status === 401
    ? 'Not signed in'
    : 'Could not check the session';
}

/**
 * The operator menu of the Studio Shell top bar: who is signed in and the logout action. The
 * session has no display name, so the operator is shown as "Operator". Asking the API for the
 * session also sends the browser to the login page on 401; the API, not this menu, enforces
 * authorization. `children` are extra items the shell adds (the theme toggle on phones).
 *
 * A failed logout (403, 5xx, network error) may leave the session valid, so the menu stays open
 * and says so instead of pretending the operator is signed out.
 */
export function OperatorMenu({ children }: { children?: ReactNode }) {
  const session = useQuery({ queryKey: SESSION_QUERY_KEY, queryFn: api.getSession });
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function logOut() {
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
    // Not modal: a modal menu hides the rest of the page from assistive tech, including the
    // logout alert below.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full pointer-coarse:size-11"
        >
          <span
            aria-hidden="true"
            className="inline-flex size-[30px] items-center justify-center rounded-full bg-brand-solid text-caption font-semibold text-on-brand"
          >
            OP
          </span>
          {/* Content, not aria-label: the name need not repeat the visible initials. */}
          <span className="sr-only">Operator menu</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[220px]">
        <div className="px-2.5 pt-2 pb-2.5">
          <p className="text-label font-semibold text-text">Operator</p>
          <p className="text-caption text-text-dim">
            {sessionLabel(session.status, session.error)}
          </p>
        </div>
        <DropdownMenuSeparator />
        {children}
        <DropdownMenuItem
          disabled={pending}
          aria-describedby={failed ? 'logout-error' : undefined}
          onSelect={(event) => {
            // Stay open: the menu shows the pending state and any failure.
            event.preventDefault();
            void logOut();
          }}
        >
          <LogOut aria-hidden="true" />
          {pending ? 'Logging out…' : 'Log out'}
        </DropdownMenuItem>
        {failed ? (
          // Shown in the menu but announced from outside it: a menu may own only menu items.
          <p
            id="logout-error"
            aria-hidden="true"
            className="px-2.5 py-2 text-caption text-run-failed"
          >
            {LOGOUT_FAILED}
          </p>
        ) : null}
      </DropdownMenuContent>
      {failed ? (
        <span role="alert" className="sr-only">
          {LOGOUT_FAILED}
        </span>
      ) : null}
    </DropdownMenu>
  );
}
