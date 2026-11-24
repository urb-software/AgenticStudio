'use client';

import { DatabaseZapIcon, ExternalLinkIcon, HammerIcon, SquareIcon } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
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
  previewLimitOf,
  previewRefusalsOf,
} from '../../../../platform/api';
import {
  usePreviewBuildLog,
  useRequestPreviewBuild,
  useStopPreview,
} from '../../api/preview-queries';
import { FAILURE_MESSAGE, PREVIEW_REMOVED_MESSAGE } from './failure-messages';
import { RefusalList } from './refusal-list';
import { ResetPreviewDataDialog } from './reset-preview-data-dialog';

const TITLE_ID = 'preview-build-title';

const PILL: Record<PreviewOutput['state'], { status: PillStatus; label: string }> = {
  not_configured: { status: 'none', label: 'Not configured' },
  stopped: { status: 'cancelled', label: 'Stopped' },
  stopping: { status: 'running', label: 'Stopping' },
  resetting_data: { status: 'running', label: 'Resetting data' },
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

/** What the Preview is now: the state and the commit only, so a refetch never re-announces it. */
function Summary({ preview }: { preview: PreviewOutput }) {
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
          Running commit <Commit commit={running.commit} />.
        </>
      ) : (
        <>The Preview is running.</>
      );
    case 'stopping':
      return <>Stopping the Preview.</>;
    case 'resetting_data':
      return <>Removing the Preview&apos;s data.</>;
    case 'failed':
      return <>The latest build failed.</>;
  }
}

function BuildLog({ projectId, build }: { projectId: string; build: PreviewBuildOutput }) {
  const log = usePreviewBuildLog(projectId, build.id);
  if (log.unavailable) {
    return <p className="m-0 text-small text-text-muted">The log is not available.</p>;
  }
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

const CHANGE_LABEL: Record<NonNullable<PreviewOutput['latestChange']>['kind'], string> = {
  stop: 'The stop failed.',
  reset_data: 'Removing the data failed.',
};

/** A stop or a reset that failed; one that is under way or done shows in the state instead. */
function LatestChange({ change }: { change: PreviewOutput['latestChange'] }) {
  if (!change || change.status !== 'failed') return null;
  const { failure } = change;
  return (
    <Banner tone="danger" title={CHANGE_LABEL[change.kind]}>
      {failure ? <span>{FAILURE_MESSAGE[failure.code]} </span> : null}
      {failure?.detail ? (
        <span className="font-mono text-code break-words">{failure.detail}</span>
      ) : null}
    </Banner>
  );
}

/** The 409 of a build the limit refused: its detail, and a link to each Preview that runs. */
function LimitBanner({ problem }: { problem: NonNullable<ReturnType<typeof previewLimitOf>> }) {
  return (
    <Banner tone="warning" title="The limit of running Previews is reached.">
      <span>{problem.detail}</span>
      <ul className="m-0 mt-2 flex list-disc flex-col gap-1 pl-5">
        {problem.running.map((project) => (
          <li key={project.projectId}>
            <Link href={`/projects/${project.projectId}/preview`}>{project.name}</Link>
          </li>
        ))}
      </ul>
    </Banner>
  );
}

function buttonLabel(state: PreviewOutput['state']): string {
  if (state === 'running') return 'Rebuild';
  if (state === 'failed') return 'Retry build';
  return 'Build';
}

type BuildCardProps = { projectId: string; preview: PreviewOutput; dataUpdatedAt: number };

/** The Preview's state, its Build button and link, and the latest build with its log. */
export function BuildCard({ projectId, preview, dataUpdatedAt }: BuildCardProps) {
  const request = useRequestPreviewBuild(projectId);
  const stop = useStopPreview(projectId);
  const [resetOpen, setResetOpen] = useState(false);
  const { state, settings, running, latestBuild } = preview;
  const pill = PILL[state];
  const configured = settings !== null;
  const canBuild = configured && preview.repository.ready && preview.controller.connected;
  const refusals = previewRefusalsOf(request.error);
  const limit = previewLimitOf(request.error);
  const otherError =
    request.error instanceof ApiError && refusals.length === 0 && !limit ? request.error : null;
  const stopError = stop.error instanceof ApiError ? stop.error : null;
  const changing = state === 'building' || state === 'stopping' || state === 'resetting_data';
  const busy = request.isPending || stop.isPending;
  const connected = preview.controller.connected;
  const canStop = state === 'running' && connected;
  const canReset = connected && latestBuild !== null;

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
              <Summary preview={preview} />
            </p>
            {state === 'running' && running ? (
              <span className="text-small text-text-muted">
                since <Time iso={running.since} now={dataUpdatedAt} />
              </span>
            ) : null}
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
          {limit ? <LimitBanner problem={limit} /> : null}
          {stopError ? (
            <Banner tone="danger" title="The Preview was not stopped.">
              {stopError.message}
            </Banner>
          ) : null}
          <LatestChange change={preview.latestChange} />
          {otherError ? (
            <Banner tone="danger" title="The build was not started.">
              {otherError.message}
            </Banner>
          ) : null}
          {canBuild || canStop || canReset || running?.url ? (
            <div className="flex flex-wrap gap-2">
              {canBuild ? (
                <Button
                  variant="primary"
                  icon={HammerIcon}
                  loading={request.isPending}
                  disabled={changing || busy}
                  onClick={() => request.mutate()}
                >
                  {buttonLabel(state)}
                </Button>
              ) : null}
              {canStop ? (
                <Button
                  icon={SquareIcon}
                  loading={stop.isPending}
                  disabled={busy}
                  onClick={() => stop.mutate()}
                >
                  Stop
                </Button>
              ) : null}
              {canReset ? (
                <Button
                  variant="danger"
                  icon={DatabaseZapIcon}
                  disabled={changing || busy}
                  onClick={() => setResetOpen(true)}
                >
                  Reset data…
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
      {/* Mounted in every state, so it closes itself once Reset data is no longer offered. */}
      <ResetPreviewDataDialog
        projectId={projectId}
        rebuildCommit={state === 'running' && running ? running.commit : null}
        open={resetOpen && canReset}
        onOpenChange={setResetOpen}
      />
    </Card>
  );
}
