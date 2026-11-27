import { WorkflowDiagram } from '../../../workflows';
import type { WorkflowItemOutput } from '../../../../platform/api';
import { Banner } from '@/shared/components/banner';

/** What the panel shows: the phases of the text as typed, or of the last text that parsed. */
export interface PanelState {
  items: WorkflowItemOutput[];
  sendBacks: number;
}

/**
 * The read-only diagram of the open workflow's Draft state beside its entry file. While the text
 * has a problem that stops it from parsing, the last state that parsed is shown, and the panel says so.
 */
export function WorkflowPanel({
  shown,
  stale,
}: {
  shown: PanelState | undefined;
  /** True while `shown` is the last valid state, not the text as it stands. */
  stale: boolean;
}) {
  return (
    <section
      aria-label="Diagram of the Draft"
      className="flex flex-col gap-3 border-t border-border p-3 lg:w-80 lg:shrink-0 lg:overflow-auto lg:border-t-0 lg:border-l"
    >
      <h2 className="m-0 text-label font-semibold">Diagram of the Draft</h2>
      {stale ? (
        <Banner tone="warning">
          {shown
            ? 'The text has a problem, so this is the last state that could be read.'
            : 'The text has a problem, and there is no earlier state to show.'}
        </Banner>
      ) : null}
      {shown ? (
        <WorkflowDiagram items={shown.items} sendBacks={shown.sendBacks} />
      ) : stale ? null : (
        <p className="m-0 text-small text-text-muted">Reading the workflow.</p>
      )}
    </section>
  );
}
