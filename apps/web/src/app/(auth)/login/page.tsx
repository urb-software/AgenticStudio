import type { Metadata } from 'next';
import { LoginForm } from '../../../platform/auth';
import { Card } from '@/shared/ui/card';
import { LogoMark } from '@/shared/components/logo-mark';

export const metadata: Metadata = { title: 'Sign in · AI Agent Studio' };

/**
 * The login screen (prototype "LOGIN"): a centred 400px card with the logo tile, the heading
 * and the password form; on phones the card spans the width and pads `space-4`. The logo tile
 * is the shared LogoMark, as in the sidebar. No shell: this page is outside `(studio)`.
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4 md:p-6">
      <Card className="w-full max-w-[400px] gap-5 p-4 md:p-8">
        <div className="flex items-center gap-2.5">
          <LogoMark />
          <span className="text-section-title font-semibold tracking-[-0.01em]">Agent Studio</span>
        </div>
        <div>
          <h1 className="m-0 text-page-title font-semibold tracking-[-0.015em]">Sign in</h1>
          <p className="mt-1.5 mb-0 text-label text-text-muted">
            This workspace has a single operator. Enter the password configured on the server.
          </p>
        </div>
        <LoginForm />
      </Card>
    </main>
  );
}
