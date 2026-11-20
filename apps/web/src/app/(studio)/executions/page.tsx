import type { Metadata } from 'next';
import { ExecutionsOverview } from '../../../modules/executions';

export const metadata: Metadata = { title: 'Executions · AI Agent Studio' };

export default function ExecutionsPage() {
  // The Studio Shell provides the `main` landmark and the breadcrumb.
  return (
    <div className="flex flex-col gap-5">
      <ExecutionsOverview />
    </div>
  );
}
