'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/shared/ui/skeleton';

// The agents module's public entry for the editor: the Agents page imports the module too, and
// must not carry the editor's code, so the view loads only when the editor route renders it.
export const AgentEditor = dynamic(
  () => import('./agent-editor').then((module) => module.AgentEditor),
  {
    ssr: false,
    loading: () => (
      <div role="status" aria-busy="true" aria-label="Loading the editor" className="py-2">
        <Skeleton className="h-3.5 w-64 max-w-full" />
      </div>
    ),
  },
);
