'use client';

import { FileLockIcon, LockIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { EmptyState } from '@/shared/components/empty-state';
import { formatExactTime, formatTimeAgo } from '@/shared/lib/relative-time';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { toast } from '@/shared/ui/sonner';
import { useEnvironmentFile } from '../../api/projects-queries';
import { EnvironmentFileDialog } from './environment-file-dialog';
import { RemoveEnvironmentFileDialog } from './remove-environment-file-dialog';

const TITLE_ID = 'environment-file-card-title';

/** A size as the card shows it: bytes, then KiB with one decimal. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-small text-text-muted max-md:mt-2 max-md:first:mt-0">{term}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}

export function EnvironmentFileCard({ projectId }: { projectId: string }) {
  const { data, isPending, isError, isRefetching, refetch, dataUpdatedAt } =
    useEnvironmentFile(projectId);
  const [editOpen, setEditOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  // A fresh form each time the dialog opens.
  const [dialogKey, setDialogKey] = useState(0);

  function openEdit() {
    setDialogKey((key) => key + 1);
    setEditOpen(true);
  }

  let body: ReactNode;
  if (isPending) {
    body = (
      <div role="status" aria-busy="true" aria-label="Loading the environment file">
        <Skeleton className="h-4 w-48 max-w-full" />
      </div>
    );
  } else if (isError) {
    body = (
      <Banner
        tone="danger"
        title="Couldn't load the environment file."
        action={
          <Button
            size="sm"
            icon={RefreshCwIcon}
            loading={isRefetching}
            onClick={() => void refetch()}
          >
            Retry
          </Button>
        }
      >
        Check the connection and try again.
      </Banner>
    );
  } else if (data === null) {
    body = (
      <EmptyState
        icon={FileLockIcon}
        title="No environment file"
        description="Many projects need a local settings file (such as .env) to start their stack and run integration and end-to-end tests. Studio can write one, with test values, into each run's working copy."
        action={
          <Button variant="primary" icon={PlusIcon} onClick={openEdit}>
            Set environment file
          </Button>
        }
      />
    );
  } else {
    const updatedAt = new Date(data.updatedAt);
    body = (
      <div className="flex flex-col gap-4">
        <p className="m-0 flex items-center gap-2 text-body">
          <LockIcon aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
          An environment file is set.
        </p>
        <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 text-body md:grid-cols-[max-content_minmax(0,1fr)] md:gap-y-2.5">
          <Detail term="Path">
            <code className="font-mono text-code break-all">{data.path}</code>
          </Detail>
          <Detail term="Content">
            <span className="font-mono text-code" aria-hidden="true">
              ••••••••
            </span>
            <span className="sr-only">Hidden</span>
            <span className="ml-2 text-small text-text-muted">Stored outside Git, write-only</span>
          </Detail>
          <Detail term="Size">{formatSize(data.sizeBytes)}</Detail>
          <Detail term="Last changed">
            <time dateTime={data.updatedAt} title={formatExactTime(updatedAt)}>
              {formatTimeAgo(updatedAt, dataUpdatedAt)}
            </time>
          </Detail>
        </dl>
        <p className="m-0 text-small text-text-muted">
          Test values only: the agent can read this file and could print or send its content. Runs
          started from now on get the current file.
        </p>
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <Button icon={RefreshCwIcon} onClick={openEdit}>
            Replace
          </Button>
          <Button variant="danger" icon={Trash2Icon} onClick={() => setRemoveOpen(true)}>
            Remove
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <Card aria-labelledby={TITLE_ID}>
        <CardHeader>
          <CardTitle id={TITLE_ID}>Environment file</CardTitle>
        </CardHeader>
        <CardContent>{body}</CardContent>
      </Card>
      <EnvironmentFileDialog
        key={dialogKey}
        projectId={projectId}
        currentPath={data?.path}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={() => toast.success('Environment file saved')}
      />
      {/* Mounted in every state, so it can close itself once the file is gone. */}
      <RemoveEnvironmentFileDialog
        projectId={projectId}
        path={data?.path ?? ''}
        open={removeOpen && Boolean(data)}
        onOpenChange={setRemoveOpen}
        onRemoved={() => toast.success('Environment file removed')}
      />
    </>
  );
}
