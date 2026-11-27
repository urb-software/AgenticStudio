'use client';

import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { Banner } from '@/shared/components/banner';
import { EmptyState } from '@/shared/components/empty-state';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { ApiError } from '../../../../platform/api';
import { useWorkflow } from '../../api/workflows-queries';
import { Problems } from '../../components/problems';
import { WorkflowDiagram } from '../workflow-diagram/workflow-diagram';

/**
 * One Workflow: why it cannot be used, if it cannot, and the diagram of its phases with the
 * path back from a review to the work before it. Everything shown is text from the definitions
 * Repository; nothing in it is rendered as markup.
 */
export function WorkflowDetail({ name, commit }: { name: string; commit: string | null }) {
  const query = useWorkflow(name, commit);

  if (query.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading the Workflow"
        className="flex flex-col gap-3"
      >
        <Skeleton className="h-3.5 w-64 max-w-full" />
        <Skeleton className="h-3.5 w-40" />
      </div>
    );
  }
  if (query.isError) {
    const gone = query.error instanceof ApiError && query.error.status === 404;
    return (
      <EmptyState
        tone="error"
        icon={TriangleAlertIcon}
        title={gone ? 'This Workflow is no longer in the Repository' : "Couldn't load the Workflow"}
        description={
          <span className="font-mono text-small">
            GET /api/workflows/{encodeURIComponent(name)}
          </span>
        }
        action={
          <Button
            icon={RefreshCwIcon}
            loading={query.isRefetching}
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        }
      />
    );
  }

  const detail = query.data;
  return (
    <div className="flex flex-col gap-4">
      {detail.problems.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Banner tone="danger">
            This Workflow cannot be used until its problems are fixed.
            {detail.items.length === 0 ? ' Its phases are not shown.' : null}
          </Banner>
          <Problems problems={detail.problems} />
        </div>
      ) : detail.notUsableReason ? (
        <Banner tone="warning">{detail.notUsableReason}</Banner>
      ) : null}
      {detail.items.length > 0 && detail.sendBacks !== null ? (
        <section aria-label="Phases of this Workflow" className="flex flex-col gap-2">
          <h3 className="m-0 text-small font-semibold">Phases</h3>
          <WorkflowDiagram items={detail.items} sendBacks={detail.sendBacks} />
        </section>
      ) : null}
    </div>
  );
}
