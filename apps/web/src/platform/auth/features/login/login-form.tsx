'use client';

import { LockIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useRef, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { TextField } from '@/shared/components/text-field';
import { Button } from '@/shared/ui/button';
import { api, ApiError } from '../../../api';

/** Where a failed login is shown: next to the field, as a lockout, or as a server error. */
type LoginError =
  | { kind: 'field'; message: string }
  | { kind: 'rate-limited'; title: string; message: string }
  | { kind: 'server'; title?: string; message: string };

function errorFor(error: unknown): LoginError {
  if (!(error instanceof ApiError)) {
    return { kind: 'server', message: 'The Studio API is unreachable. Try again.' };
  }
  switch (error.status) {
    case 401:
      return { kind: 'field', message: 'Wrong password.' };
    case 429: {
      const minutes = Math.ceil((error.retryAfterSeconds ?? 60) / 60);
      return {
        kind: 'rate-limited',
        title: 'Too many failed attempts.',
        message: `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      };
    }
    default:
      return error.problem
        ? {
            kind: 'server',
            title: error.problem.title,
            message: error.problem.detail || 'Login failed. Try again.',
          }
        : { kind: 'server', message: 'Login failed. Try again.' };
  }
}

/** Password-only operator login. The session cookie is set by the API (HttpOnly). */
export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<LoginError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // State updates land after the next render; the ref stops a second submit before that.
  const inFlight = useRef(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || password.length === 0) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await api.login(password);
      router.replace('/');
    } catch (cause) {
      setError(errorFor(cause));
      setSubmitting(false);
      inFlight.current = false;
    } finally {
      setPassword('');
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <TextField
        id="password"
        name="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        disabled={submitting}
        error={error?.kind === 'field' ? error.message : undefined}
      />
      {error?.kind === 'rate-limited' ? (
        // Assertive, as the lockout message was before #44 (a warning is polite by default).
        <Banner tone="warning" announce="assertive" icon={LockIcon} title={error.title}>
          {error.message}
        </Banner>
      ) : null}
      {error?.kind === 'server' ? (
        <Banner tone="danger" title={error.title}>
          {error.message}
        </Banner>
      ) : null}
      <Button
        type="submit"
        variant="primary"
        size="lg"
        loading={submitting}
        disabled={password.length === 0}
      >
        {submitting ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
