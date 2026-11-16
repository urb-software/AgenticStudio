import type { Metadata } from 'next';
import { RunDetail } from '../../../../modules/executions';

export const metadata: Metadata = { title: 'Run · AI Agent Studio' };

export default async function RunPage({ params }: PageProps<'/executions/[runId]'>) {
  const { runId } = await params;
  // The Studio Shell provides the `main` landmark (#43). Keyed by the Run, so moving to another
  // Run (e.g. "Run again") starts on its Log tab (Issue #144).
  return <RunDetail key={runId} runId={runId} />;
}
