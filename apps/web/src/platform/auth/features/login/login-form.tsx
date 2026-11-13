'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { api, ApiError } from '../../../api';

function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'The Studio API is unreachable. Try again.';
  }
  switch (error.status) {
    case 401:
      return 'Wrong password.';
    case 429: {
      const minutes = Math.ceil((error.retryAfterSeconds ?? 60) / 60);
      return `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
    }
    default:
      return error.problem?.detail ?? 'Login failed. Try again.';
  }
}

/** Password-only operator login. The session cookie is set by the API (HttpOnly). */
export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.login(password);
      router.replace('/');
    } catch (cause) {
      setError(messageFor(cause));
      setSubmitting(false);
    } finally {
      setPassword('');
    }
  }

  return (
    <form onSubmit={onSubmit} aria-describedby={error ? 'login-error' : undefined}>
      <label htmlFor="password">Password</label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        disabled={submitting}
      />
      <button type="submit" disabled={submitting || password.length === 0}>
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
      {error ? (
        <p id="login-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
