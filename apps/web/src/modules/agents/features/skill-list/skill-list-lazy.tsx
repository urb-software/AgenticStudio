'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/shared/ui/skeleton';

// The agents module's public entry for the Skills view: the Agents page imports the module too,
// and must not carry this view's code, so it loads only when the skills route renders it.
export const SkillList = dynamic(() => import('./skill-list').then((module) => module.SkillList), {
  ssr: false,
  loading: () => (
    <div role="status" aria-busy="true" aria-label="Loading the skills" className="py-2">
      <Skeleton className="h-3.5 w-64 max-w-full" />
    </div>
  ),
});
