import type { Metadata } from 'next';
import { AgentsOverview } from '../../../modules/agents';

export const metadata: Metadata = { title: 'Agents · AI Agent Studio' };

export default function AgentsPage() {
  // The Studio Shell provides the `main` landmark and the breadcrumb.
  return (
    <div className="flex flex-col gap-5">
      <AgentsOverview />
    </div>
  );
}
