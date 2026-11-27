import type { Metadata } from 'next';
import { Suspense } from 'react';
import { WorkflowList } from '../../../modules/workflows';

export const metadata: Metadata = { title: 'Workflows · AI Agent Studio' };

export default function WorkflowsPage() {
  // The Studio Shell provides the `main` landmark and the breadcrumb.
  return (
    <div className="flex flex-col gap-5">
      <Suspense>
        <WorkflowList />
      </Suspense>
    </div>
  );
}
