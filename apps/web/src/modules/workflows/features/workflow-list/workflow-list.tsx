'use client';

import { AGENT_NAME_PATTERN } from '@agentic-studio/agent-definitions';
import { useEffect, useId, useRef, useState } from 'react';
import { RefreshCwIcon, TriangleAlertIcon, WorkflowIcon } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Banner } from '@/shared/components/banner';
import { EmptyState } from '@/shared/components/empty-state';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { type WorkflowListOutput, type WorkflowSummaryOutput } from '../../../../platform/api';
import { useWorkflows } from '../../api/workflows-queries';
import { Problems } from '../../components/problems';
import { readRequestOf, shortSha, workflowEditorHref } from '../../components/workflow-links';
import { WorkflowDetail } from '../workflow-detail/workflow-detail';

const READ_REQUEST = 'GET /api/workflows';
const TITLE_ID = 'workflows-title';
const TRUNCATED = 'More Workflow folders exist than are listed here.';

/** Why no (or only the last known) Workflows can be read, or null when all is well. */
function repositoryReason(list: WorkflowListOutput): string | null {
  if (list.repository === null) {
    return 'No definitions Repository is connected, so there are no Workflows to list. Connect it on the Agents page.';
  }
  if (list.repository.note) return list.repository.note;
  if (list.commit === null) {
    return 'Nothing has been fetched from the definitions Repository yet, so there are no Workflows to list. Fetch it on the Agents page.';
  }
  return null;
}

function StateLabel({ workflow }: { workflow: WorkflowSummaryOutput }) {
  if (!workflow.valid) {
    return (
      <span className="text-caption font-medium whitespace-nowrap text-run-failed">Not valid</span>
    );
  }
  return workflow.usable ? (
    <span className="text-caption font-medium whitespace-nowrap text-run-succeeded">Usable</span>
  ) : (
    <span className="text-caption font-medium whitespace-nowrap text-run-failed">Not usable</span>
  );
}

function WorkflowRow({
  workflow,
  commit,
  open,
  arrived,
  onToggle,
}: {
  workflow: WorkflowSummaryOutput;
  commit: string | null;
  open: boolean;
  arrived: boolean;
  onToggle: () => void;
}) {
  const detailId = useId();
  const row = useRef<HTMLLIElement>(null);
  // A link to this Workflow brings its row into view once; focus stays where it is.
  useEffect(() => {
    if (arrived) row.current?.scrollIntoView({ block: 'nearest' });
  }, [arrived]);
  const openable = AGENT_NAME_PATTERN.test(workflow.name);
  const hasEntry =
    openable && !workflow.problems.some((problem) => problem.code === 'entry_missing');
  return (
    <li ref={row} className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-code font-semibold break-all">{workflow.name}</span>
        <StateLabel workflow={workflow} />
        {hasEntry ? (
          <Button asChild className="ml-auto">
            <Link href={workflowEditorHref(workflow.name)}>
              Open in editor<span className="sr-only"> ({workflow.name})</span>
            </Link>
          </Button>
        ) : null}
        {openable ? (
          <Button
            className={hasEntry ? undefined : 'ml-auto'}
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            aria-label={`${open ? 'Hide' : 'Show'} ${workflow.name}`}
            onClick={onToggle}
          >
            {open ? 'Hide' : 'Show'}
          </Button>
        ) : null}
      </div>
      {workflow.description ? (
        <p className="m-0 text-small text-text-muted">{workflow.description}</p>
      ) : null}
      {workflow.notUsableReason ? (
        <p className="m-0 text-small text-run-failed">{workflow.notUsableReason}</p>
      ) : null}
      {workflow.problems.length > 0 ? <Problems problems={workflow.problems} /> : null}
      {open && openable ? (
        <div id={detailId} className="mt-1 border-t border-border pt-3">
          <WorkflowDetail name={workflow.name} commit={commit} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * The Workflows of the definitions Repository at its last fetched commit, each with its
 * validation state and whether it can be chosen. The list is read again on window focus.
 * Everything shown is text.
 */
export function WorkflowList() {
  const { data, error, isPending, isError, isRefetching, refetch } = useWorkflows();
  // One Workflow is open at a time; a link with `?open=` opens its Workflow.
  const opened = useSearchParams().get('open') ?? undefined;
  const [arrivedName] = useState<string | undefined>(opened);
  const [openName, setOpenName] = useState<string | undefined>(arrivedName);

  const heading = (
    <h1 className="m-0 text-page-title font-semibold tracking-[-0.015em]">Workflows</h1>
  );

  if (isPending) {
    return (
      <>
        {heading}
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading the Workflows"
          className="flex flex-col gap-3"
        >
          <Skeleton className="h-3.5 w-64 max-w-full" />
          <Skeleton className="h-3.5 w-40" />
        </div>
      </>
    );
  }
  if (isError) {
    return (
      <>
        {heading}
        <EmptyState
          tone="error"
          icon={TriangleAlertIcon}
          title="Couldn't load the Workflows"
          description={
            <span className="font-mono text-small">{readRequestOf(READ_REQUEST, error)}</span>
          }
          action={
            <Button icon={RefreshCwIcon} loading={isRefetching} onClick={() => void refetch()}>
              Retry
            </Button>
          }
        />
      </>
    );
  }

  const reason = repositoryReason(data);
  if (data.workflows.length === 0) {
    const notConnected = data.repository === null;
    return (
      <>
        {heading}
        <EmptyState
          icon={WorkflowIcon}
          title={
            notConnected
              ? 'No definitions Repository connected'
              : data.commit === null
                ? 'No Workflows to show yet'
                : 'No Workflows in the definitions Repository'
          }
          description={
            reason ??
            'A Workflow is a folder workflows/<name>/ with a WORKFLOW.md file that lists its phases. Add one to the definitions Repository, push it, and fetch the Repository on the Agents page, or open the editor.'
          }
          action={
            <span className="flex flex-wrap items-center justify-center gap-2">
              <Button asChild>
                <Link href="/agents">{notConnected ? 'Connect on Agents' : 'Go to Agents'}</Link>
              </Button>
              {notConnected ? null : (
                <Button asChild>
                  <Link href="/agents/editor">Open the editor</Link>
                </Button>
              )}
            </span>
          }
        />
        {data.truncated ? <Banner tone="warning">{TRUNCATED}</Banner> : null}
      </>
    );
  }
  return (
    <>
      {heading}
      <Card aria-labelledby={TITLE_ID}>
        <CardHeader>
          <CardTitle id={TITLE_ID}>Workflows</CardTitle>
          <span className="text-small text-text-muted">
            {data.commit ? (
              <>
                Read at commit{' '}
                <code className="text-code" title={data.commit}>
                  {shortSha(data.commit)}
                </code>
              </>
            ) : (
              'No commit read'
            )}
          </span>
        </CardHeader>
        <CardContent flush>
          {reason ? (
            <Banner tone="warning" className="m-4">
              {reason}
            </Banner>
          ) : null}
          {data.truncated ? (
            <Banner tone="warning" className="m-4">
              {TRUNCATED}
            </Banner>
          ) : null}
          <ul className="m-0 flex list-none flex-col p-0">
            {data.workflows.map((workflow) => (
              <WorkflowRow
                key={workflow.name}
                workflow={workflow}
                commit={data.commit}
                open={openName === workflow.name}
                arrived={arrivedName === workflow.name}
                onToggle={() => setOpenName(openName === workflow.name ? undefined : workflow.name)}
              />
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
