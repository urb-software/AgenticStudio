import type { Metadata } from 'next';
import { LoginForm } from '../../../modules/auth';

export const metadata: Metadata = { title: 'Sign in · AI Agent Studio' };

export default function LoginPage() {
  return (
    <main>
      <h1>Sign in</h1>
      <LoginForm />
    </main>
  );
}
