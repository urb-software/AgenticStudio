'use client';

import {
  ArrowLeftIcon,
  GlobeIcon,
  RefreshCwIcon,
  SearchXIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { CopyButton } from '@/shared/components/copy-button';
import { EmptyState } from '@/shared/components/empty-state';
import { formatExactTime, formatTimeAgo } from '@/shared/lib/relative-time';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { toast } from '@/shared/ui/sonner';
import { ApiError, type PreviewOutput } from '../../../../platform/api';
import { usePreview, useProjectKind } from '../../api/preview-queries';
import { BuildCard } from './build-card';
import { PreviewSettingsForm } from './preview-settings-form';
import { RemovePreviewSettingsDialog } from './remove-preview-settings-dialog';

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-small text-text-muted max-md:mt-2 max-md:first:mt-0">{term}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}

function LoadingPreview() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading the Preview"
      className="flex flex-col gap-3"
    >
      <Skeleton className="h-7 w-40 max-w-full" />
      <Skeleton className="h-3.5 w-64 max-w-full" />
    </div>
  );
}

function CurrentSettings({
  settings,
  dataUpdatedAt,
  onRemove,
}: {
  settings: NonNullable<PreviewOutput['settings']>;
  dataUpdatedAt: number;
  onRemove: () => void;
}) {
  const updatedAt = new Date(settings.updatedAt);
  return (
    <div className="flex flex-col gap-4">
      <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 text-body md:grid-cols-[max-content_minmax(0,1fr)] md:gap-y-2.5">
        <Detail term="Compose file">
          <code className="font-mono text-code break-all">{settings.composeFile}</code>
        </Detail>
        <Detail term="Service">
          <code className="font-mono text-code break-all">{settings.service}</code>
        </Detail>
        <Detail term="Port">
          <code className="font-mono text-code">{settings.port}</code>
        </Detail>
        <Detail term="Last changed">
          <time dateTime={settings.updatedAt} title={formatExactTime(updatedAt)}>
            {formatTimeAgo(updatedAt, dataUpdatedAt)}
          </time>
        </Detail>
      </dl>
      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <Button variant="danger" icon={Trash2Icon} onClick={onRemove}>
          Remove settings
        </Button>
      </div>
    </div>
  );
}

function NotConfigured() {
  return (
    <EmptyState
      icon={GlobeIcon}
      title="No Preview configured"
      description={
        <>
          A Preview is the project&apos;s own Compose stack, built from the integration branch. To
          set one up, put a Compose file in the repository (for example{' '}
          <code className="text-code">compose.yaml</code>), then name the service that serves the
          app and the port it listens on below. Studio checks the file when you save the settings.
        </>
      }
    />
  );
}

function Hostname({ preview }: { preview: PreviewOutput }) {
  if (preview.hostname === null) {
    return (
      <Banner tone="info" title="No hostname yet.">
        This Studio has no preview domain configured, so the Preview has no address to be served at.
        Set <code className="text-code">STUDIO_PREVIEW_DOMAIN</code> in the API&apos;s environment
        (see the deployment guide).
      </Banner>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="font-mono text-code break-all">{preview.hostname}</code>
      <CopyButton value={preview.hostname} label="Copy the Preview hostname" />
    </div>
  );
}

/**
 * A project's Preview: its settings, the hostname it will be served at, and the form to change
 * them. The definitions Repository has none, so an old link to it says so up front.
 */
export function PreviewPage({ projectId }: { projectId: string }) {
  const kind = useProjectKind(projectId);
  // Starts the Preview read at the same time as the kind's (one cache entry, shared with the
  // content below), so an ordinary project does not wait for two round trips in a row.
  usePreview(projectId);
  if (kind.isPending) return <LoadingPreview />;
  if (kind.data === 'definitions') {
    return (
      <EmptyState
        icon={GlobeIcon}
        title="The definitions Repository has no Preview"
        description="It holds agent definitions only. A Preview belongs to your other projects."
        action={
          <Button asChild icon={ArrowLeftIcon}>
            <Link href="/projects">Back to Projects</Link>
          </Button>
        }
      />
    );
  }
  return <PreviewContent projectId={projectId} />;
}

function PreviewContent({ projectId }: { projectId: string }) {
  const { data, error, isPending, isError, isRefetching, refetch, dataUpdatedAt } =
    usePreview(projectId);
  const [removeOpen, setRemoveOpen] = useState(false);

  if (isPending) return <LoadingPreview />;
  if (isError) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <EmptyState
          icon={SearchXIcon}
          title="Project not found"
          description="It may never have existed, or the link is wrong."
          action={
            <Button asChild icon={ArrowLeftIcon}>
              <Link href="/projects">Back to Projects</Link>
            </Button>
          }
        />
      );
    }
    return (
      <EmptyState
        tone="error"
        icon={TriangleAlertIcon}
        title="Couldn't load the Preview"
        description={
          <span className="font-mono text-small">
            GET /api/projects/{'{id}'}/preview
            {error instanceof ApiError && error.status > 0 ? ` · ${error.status}` : ''}
          </span>
        }
        action={
          <Button icon={RefreshCwIcon} loading={isRefetching} onClick={() => void refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  return (
    <>
      <header className="flex min-w-0 flex-col gap-2">
        <h1 className="m-0 text-page-title font-semibold tracking-[-0.015em]">Preview</h1>
        <Button asChild icon={ArrowLeftIcon} variant="ghost" className="self-start">
          <Link href={`/projects/${projectId}`}>Back to the project</Link>
        </Button>
      </header>
      <BuildCard projectId={projectId} preview={data} dataUpdatedAt={dataUpdatedAt} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card aria-labelledby="preview-current-title">
          <CardHeader>
            <CardTitle id="preview-current-title">Current Preview</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              {data.settings ? (
                <CurrentSettings
                  settings={data.settings}
                  dataUpdatedAt={dataUpdatedAt}
                  onRemove={() => setRemoveOpen(true)}
                />
              ) : (
                <NotConfigured />
              )}
              <div className="flex flex-col gap-1.5">
                <h3 className="m-0 text-label font-medium text-text-muted">Hostname</h3>
                <Hostname preview={data} />
              </div>
            </div>
          </CardContent>
        </Card>
        <PreviewSettingsForm
          projectId={projectId}
          settings={data.settings}
          repository={data.repository}
        />
      </div>
      {/* Mounted in every state, so it can close itself once the settings are gone. */}
      <RemovePreviewSettingsDialog
        projectId={projectId}
        composeFile={data.settings?.composeFile ?? ''}
        open={removeOpen && data.settings !== null}
        onOpenChange={setRemoveOpen}
        onRemoved={() => toast.success('Preview settings removed')}
      />
    </>
  );
}
