'use client';

import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { Banner } from '@/shared/components/banner';
import { EmptyState } from '@/shared/components/empty-state';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { ApiError } from '../../../../platform/api';
import { useSkill } from '../../api/skills-queries';
import { formatSize } from '../../components/format-size';
import { PlainText } from '../../components/plain-text';
import { Problems } from '../../components/problems';

/**
 * One skill: its instructions as plain text (nothing in it is rendered, run or followed) and the
 * files of its folder with their sizes. An invalid skill shows its problems and no instructions.
 */
export function SkillDetail({ name, commit }: { name: string; commit: string | null }) {
  const query = useSkill(name, commit);

  if (query.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading the skill"
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
        title={gone ? 'This skill is no longer in the Repository' : "Couldn't load the skill"}
        description={
          <span className="font-mono text-small">GET /api/skills/{encodeURIComponent(name)}</span>
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
      {detail.valid ? (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 text-small font-semibold">Instructions</h3>
          {detail.instructions === '' ? (
            <p className="m-0 text-small text-text-muted">
              The instructions of this skill are empty.
            </p>
          ) : (
            <PlainText text={detail.instructions} role="region" aria-label="Instructions text" />
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Banner tone="danger">
            This skill is not valid until its problems are fixed. Its instructions are not shown.
          </Banner>
          <Problems problems={detail.problems} subject="skill" />
        </div>
      )}
      {detail.files.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 text-small font-semibold">Files</h3>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-small">
            {detail.files.map((file) => (
              <li key={file.path} className="flex justify-between gap-3">
                <span className="font-mono text-code break-all">{file.path}</span>
                <span className="shrink-0 text-text-muted">{formatSize(file.size)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
