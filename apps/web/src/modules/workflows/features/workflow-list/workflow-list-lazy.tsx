'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/shared/ui/skeleton';

// The module's public entry: the route loads the view's code only when it renders it.
export const WorkflowList = dynamic(
  () => import('./workflow-list').then((module) => module.WorkflowList),
  {
    ssr: false,
    loading: () => (
      <div role="status" aria-busy="true" aria-label="Loading the Workflows" className="py-2">
        <Skeleton className="h-3.5 w-64 max-w-full" />
      </div>
    ),
  },
);
