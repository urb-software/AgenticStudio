'use client';

import { ExternalLinkIcon, HammerIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Banner } from '@/shared/components/banner';
import { LogViewer } from '@/shared/components/log-viewer';
import { StatusPill, type PillStatus } from '@/shared/components/status-pill';
import { formatExactTime, formatTimeAgo } from '@/shared/lib/relative-time';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import {
  ApiError,
  type PreviewBuildOutput,
  type PreviewOutput,
  previewRefusalsOf,
} from '../../../../platform/api';
import { usePreviewBuildLog, useRequestPreviewBuild } from '../../api/preview-queries';
import { FAILURE_MESSAGE, PREVIEW_REMOVED_MESSAGE } from './failure-messages';
import { RefusalList } from './refusal-list';

const TITLE_ID = 'preview-build-title';

const PILL: Record<PreviewOutput['state'], { status: PillStatus; label: string }> = {
  not_configured: { status: 'none', label: 'Not configured' },
  stopped: { status: 'cancelled', label: 'Stopped' },
  building: { status: 'running', label: 'Building' },
  running: { status: 'succeeded', label: 'Running' },
  failed: { status: 'failed', label: 'Failed' },
};

const BUILD_STATUS: Record<PreviewBuildOutput['status'], string> = {
  queued: 'Queued',
  building: 'In progress',
  succeeded: 'Succeeded',
  failed: 'Failed',
};

const shortCommit = (commit: string) => commit.slice(0, 7);

function Commit({ commit }: { commit: string }) {
  return (
    <code className="font-mono text-code" title={commit}>
      {shortCommit(commit)}
    </code>
  );
}

function Time({ iso, now }: { iso: string; now: number }) {
  const date = new Date(iso);
  return (
    <time dateTime={iso} title={formatExactTime(date)}>
      {formatTimeAgo(date, now)}
    </time>
  );
}

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-small text-text-muted max-md:mt-2 max-md:first:mt-0">{term}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}

/** The one sentence that says what the Preview is now. */
function Summary({ preview, now }: { preview: PreviewOutput; now: number }) {
  const { state, running, latestBuild } = preview;
  switch (state) {
    case 'not_configured':
      return <>No Preview is configured.</>;
    case 'stopped':
      return <>The Preview is stopped.</>;
    case 'building':
      return (
        <>
          Building commit {latestBuild ? <Commit commit={latestBuild.commit} /> : null}. This page
          follows the build.
        </>
      );
    case 'running':
      return running ? (
        <>
          Running commit <Commit commit={running.commit} /> since{' '}
          <Time iso={running.since} now={now} />.
        </>
      ) : (
        <>The Preview is running.</>
      );
    case 'failed':
      return <>The latest build failed.</>;
  }
}

function BuildLog({ projectId, build }: { projectId: string; build: PreviewBuildOutput }) {
  const log = usePreviewBuildLog(projectId, build.id);
  return (
    <div className="flex flex-col gap-2">
      <LogViewer
        label="Build log"
        rows={log.rows}
        streaming={!log.complete}
        reconnecting={log.failing && !log.complete}
        emptyText={log.complete ? 'The build wrote no log.' : 'No log lines yet.'}
        announcement={log.complete ? 'The build log is complete.' : ''}
      />
      {log.truncated ? (
        <p className="m-0 text-small text-text-muted">
          The log reached its size limit, so later lines were left out.
        </p>
      ) : null}
    </div>
  );
}

function LatestBuild({
  projectId,
  build,
  now,
}: {
  projectId: string;
  build: PreviewBuildOutput;
  now: number;
}) {
  const { failure } = build;
  return (
    <section aria-labelledby="preview-latest-build" className="flex flex-col gap-3">
      <h3 id="preview-latest-build" className="m-0 text-label font-medium text-text-muted">
        Latest build
      </h3>
      <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 text-body md:grid-cols-[max-content_minmax(0,1fr)] md:gap-y-2.5">
        <Detail term="Status">{BUILD_STATUS[build.status]}</Detail>
        <Detail term="Commit">
          <Commit commit={build.commit} />
        </Detail>
        <Detail term="Requested">
          <Time iso={build.requestedAt} now={now} />
        </Detail>
        {build.startedAt ? (
          <Detail term="Started">
            <Time iso={build.startedAt} now={now} />
          </Detail>
        ) : null}
        {build.finishedAt ? (
          <Detail term="Finished">
            <Time iso={build.finishedAt} now={now} />
          </Detail>
        ) : null}
        <Detail term="Time limit">{build.timeLimitMinutes} minutes</Detail>
      </dl>
      {failure ? (
        <div className="flex flex-col gap-2">
          <Banner tone="danger" title={FAILURE_MESSAGE[failure.code]}>
            {failure.previewRemoved ? <span>{PREVIEW_REMOVED_MESSAGE} </span> : null}
            {failure.detail ? (
              <span className="font-mono text-code break-words">{failure.detail}</span>
            ) : null}
          </Banner>
          {failure.refusals.length > 0 ? (
            <RefusalList
              refusals={failure.refusals}
              title="The Compose file was refused."
              retry="build again"
            />
          ) : null}
        </div>
      ) : null}
      {/* Keyed by build: a new build starts a new log. */}
      <BuildLog key={build.id} projectId={projectId} build={build} />
    </section>
  );
}

function buttonLabel(state: PreviewOutput['state']): string {
  if (state === 'running') return 'Rebuild';
  if (state === 'failed') return 'Retry build';
  return 'Build';
}

type BuildCardProps = { projectId: string; preview: PreviewOutput; dataUpdatedAt: number };

/**
 * The Preview's state, the Build button, the link to the running Preview and the latest build with
 * its log. Everything shown is what the API says; the page never asks the Preview itself.
 */
export function BuildCard({ projectId, preview, dataUpdatedAt }: BuildCardProps) {
  const request = useRequestPreviewBuild(projectId);
  const { state, settings, running, latestBuild } = preview;
  const pill = PILL[state];
  const configured = settings !== null;
  const canBuild = configured && preview.repository.ready && preview.controller.connected;
  const refusals = previewRefusalsOf(request.error);
  const conflict =
    request.error instanceof ApiError && request.error.status !== 422 ? request.error : null;

  return (
    <Card aria-labelledby={TITLE_ID}>
      <CardHeader>
        <CardTitle id={TITLE_ID}>Preview build</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill status={pill.status}>{pill.label}</StatusPill>
            <p aria-live="polite" className="m-0 min-w-0 flex-1 text-body">
              <Summary preview={preview} now={dataUpdatedAt} />
            </p>
          </div>
          {configured && !preview.controller.connected ? (
            <Banner tone="warning">
              No environment controller is connected. Builds start once it runs.
            </Banner>
          ) : null}
          {refusals.length > 0 ? (
            <RefusalList
              refusals={refusals}
              title="The build was not started."
              retry="build again"
            />
          ) : null}
          {conflict ? (
            <Banner tone="danger" title="The build was not started.">
              {conflict.message}
            </Banner>
          ) : null}
          {canBuild || running?.url ? (
            <div className="flex flex-wrap gap-2">
              {canBuild ? (
                <Button
                  variant="primary"
                  icon={HammerIcon}
                  loading={request.isPending}
                  disabled={state === 'building' || request.isPending}
                  onClick={() => request.mutate()}
                >
                  {buttonLabel(state)}
                </Button>
              ) : null}
              {running?.url ? (
                <Button asChild icon={ExternalLinkIcon}>
                  <a href={running.url} target="_blank" rel="noopener noreferrer">
                    Open the Preview (opens in a new tab)
                  </a>
                </Button>
              ) : null}
            </div>
          ) : null}
          {latestBuild ? (
            <div className="flex flex-col gap-4 border-t border-border pt-4">
              <LatestBuild projectId={projectId} build={latestBuild} now={dataUpdatedAt} />
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
