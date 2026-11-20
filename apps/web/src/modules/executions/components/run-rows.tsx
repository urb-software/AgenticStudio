'use client';

import { CircleCheckIcon, CircleXIcon, GitPullRequestIcon } from 'lucide-react';
import Link from 'next/link';
import { StatusPill } from '@/shared/components/status-pill';
import { formatExactTime, formatTimeAgo } from '@/shared/lib/relative-time';
import type { RunOutput } from '../../../platform/api';
import {
  PROVIDER_LABEL,
  PULL_REQUEST_STATE_VIEW,
  RUN_STATE_VIEW,
  summarizeChecks,
  taskSummary,
} from './run-presentation';

/**
 * The pass or fail marker next to a pull request's state, from the stored summary of its Pull
 * request checks: only a result is marked (a failed check, or all finished and passed), and only
 * while the pull request is open. The word is there as well as the icon.
 */
function ChecksMarker({ pullRequest }: { pullRequest: NonNullable<RunOutput['pullRequest']> }) {
  const open = pullRequest.state === 'draft' || pullRequest.state === 'open';
  if (!open || !pullRequest.checks || pullRequest.checks.length === 0) return null;
  const { marker } = summarizeChecks(pullRequest.checks);
  if (marker !== 'failed' && marker !== 'passed') return null;
  const Icon = marker === 'failed' ? CircleXIcon : CircleCheckIcon;
  return (
    <span
      data-slot="checks-marker"
      className={`inline-flex items-center gap-1 font-sans text-small ${
        marker === 'failed' ? 'text-run-failed' : 'text-run-succeeded'
      }`}
    >
      <span aria-hidden="true">· </span>
      <span className="sr-only">, </span>
      <Icon aria-hidden="true" className="size-3.5" />
      {marker === 'failed' ? 'Checks failed' : 'Checks passed'}
    </span>
  );
}

type RunRowsProps = {
  runs: readonly RunOutput[];
  /** When the list was fetched: relative times count from here. */
  now: number;
  /** The list's accessible name. */
  label: string;
  /** Project names by id: when given, each Run also shows its project (lists across projects). */
  projectNames?: ReadonlyMap<string, string>;
};

export function RunRows({ runs, now, label, projectNames }: RunRowsProps) {
  return (
    <ul role="list" aria-label={label} className="m-0 flex list-none flex-col p-0">
      {runs.map((run) => {
        const view = RUN_STATE_VIEW[run.state];
        const createdAt = new Date(run.createdAt);
        return (
          <li
            key={run.id}
            className="relative grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 border-b border-border py-3 last:border-b-0 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring md:grid-cols-[auto_1fr_auto_auto]"
          >
            <span className="row-start-1 md:col-start-1">
              <StatusPill status={view.pill}>{view.label}</StatusPill>
            </span>
            {/* The whole row opens the Run: the link's ::after covers it (one tab stop). */}
            <Link
              href={`/executions/${run.id}`}
              className="col-span-2 row-start-2 min-w-0 truncate font-medium text-text no-underline outline-none after:absolute after:inset-0 after:content-[''] hover:underline md:col-span-1 md:col-start-2 md:row-start-1"
            >
              {taskSummary(run.task)}
            </Link>
            <span className="col-span-2 row-start-3 flex min-w-0 flex-wrap gap-x-3 text-small text-text-muted md:col-span-1 md:col-start-3 md:row-start-1 md:flex-nowrap">
              <span>{PROVIDER_LABEL[run.provider]}</span>
              {run.pullRequest ? (
                // A marker, not a link: the row is one link to the Run page.
                <span className="inline-flex items-center gap-1 font-mono text-code">
                  <GitPullRequestIcon aria-hidden="true" className="size-3.5" />
                  <span className="sr-only">Pull request </span>#{run.pullRequest.number}
                  {run.pullRequest.state ? (
                    // Where the pull request stands, next to its marker.
                    <span className="font-sans text-small text-text-muted">
                      <span aria-hidden="true">· </span>
                      <span className="sr-only">, </span>
                      {PULL_REQUEST_STATE_VIEW[run.pullRequest.state].label}
                    </span>
                  ) : null}
                  <ChecksMarker pullRequest={run.pullRequest} />
                </span>
              ) : null}
              {run.followUps > 0 ? (
                // The Run has had Follow-ups.
                <span>
                  {run.followUps} {run.followUps === 1 ? 'Follow-up' : 'Follow-ups'}
                </span>
              ) : null}
              {projectNames ? (
                <span className="min-w-0 truncate md:max-w-48">
                  {projectNames.get(run.projectId) ?? 'Unknown project'}
                </span>
              ) : null}
            </span>
            <time
              dateTime={run.createdAt}
              title={formatExactTime(createdAt)}
              className="row-start-1 justify-self-end text-small text-text-dim tabular-nums md:col-start-4"
            >
              {formatTimeAgo(createdAt, now)}
            </time>
          </li>
        );
      })}
    </ul>
  );
}
