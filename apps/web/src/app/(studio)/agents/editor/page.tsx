import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AgentEditor } from '../../../../modules/agents';

export const metadata: Metadata = { title: 'Agent editor · AI Agent Studio' };

export default function AgentEditorPage() {
  // The Studio Shell provides the `main` landmark and the breadcrumb. `useSearchParams` needs a
  // Suspense boundary for the static build.
  return (
    <div className="flex flex-col gap-5">
      <Suspense>
        <AgentEditor />
      </Suspense>
    </div>
  );
}
