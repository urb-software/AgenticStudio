import { taskSummary } from '../../components/run-presentation';
import { useRun } from '../../api/runs-queries';

/**
 * The Run's title (the start of its Task), from the cached Run. The Studio Shell breadcrumb and
 * other modules use it, so it lives apart from the Run page: `fallback` shows while the Run is
 * loading or unreadable (default "Run").
 */
export function RunTitle({ runId, fallback = 'Run' }: { runId: string; fallback?: string }) {
  const { data } = useRun(runId);
  return <>{data ? taskSummary(data.task) : fallback}</>;
}
