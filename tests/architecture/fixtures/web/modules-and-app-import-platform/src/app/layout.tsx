import type { ReactNode } from 'react';
import { currentOperator } from '@/platform/auth';

export default async function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body data-operator={await currentOperator()}>{children}</body>
    </html>
  );
}
