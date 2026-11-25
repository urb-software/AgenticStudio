'use client';

import { useId, useState } from 'react';
import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { Badge } from '@/shared/components/badge';
import { Banner } from '@/shared/components/banner';
import { EmptyState } from '@/shared/components/empty-state';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { ApiError, type AgentListOutput, type AgentSummaryOutput } from '../../../../platform/api';
import { useAgents } from '../../api/agents-queries';
import { Problems } from '../../components/problems';
import { AgentDetail } from '../agent-detail/agent-detail';
import { BaseRules } from '../base-rules/base-rules';

const READ_REQUEST = 'GET /api/agents';
const TITLE_ID = 'agents-title';

const PROVIDER_LABEL = { claude_code: 'Claude Code', codex: 'Codex' } as const;

/** Rows are unique by source and name: a built-in and a refused folder can share a name. */
const rowKey = (agent: AgentSummaryOutput) => `${agent.source}:${agent.name}`;

function readRequestOf(error: unknown): string {
  if (!(error instanceof ApiError) || error.status === 0) return READ_REQUEST;
  const status = [error.status, error.problem?.title].filter(Boolean).join(' ');
  return `${READ_REQUEST} · ${status}`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Why no (or only the last known) definitions agents can be read, or null when all is well. */
function repositoryReason(list: AgentListOutput): string | null {
  if (list.repository === null) {
    return 'No definitions Repository is connected, so only the built-in agents are listed.';
  }
  if (list.repository.note) return list.repository.note;
  if (list.commit === null) {
    return 'Nothing has been fetched from the definitions Repository yet, so only the built-in agents are listed.';
  }
  return null;
}

function AgentRow({
  agent,
  open,
  onToggle,
}: {
  agent: AgentSummaryOutput;
  open: boolean;
  onToggle: () => void;
}) {
  const detailId = useId();
  const openable = !agent.problems.some((problem) => problem.code === 'name_reserved');
  return (
    <li className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-code font-semibold break-all">{agent.name}</span>
        {agent.source === 'built_in' ? <Badge>Built in</Badge> : null}
        {agent.usable ? null : (
          <span className="text-caption font-medium whitespace-nowrap text-run-failed">
            Not usable
          </span>
        )}
        {/* A reserved name is judged here only: the API answers another route for it. */}
        {openable ? (
          <Button
            className="ml-auto"
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            aria-label={`${open ? 'Hide' : 'Show'} ${agent.name}`}
            onClick={onToggle}
          >
            {open ? 'Hide' : 'Show'}
          </Button>
        ) : null}
      </div>
      {agent.usable ? (
        <>
          {agent.description ? (
            <p className="m-0 text-small text-text-muted">{agent.description}</p>
          ) : null}
          <dl className="m-0 flex flex-wrap gap-x-6 gap-y-1 text-small">
            <div className="flex gap-1.5">
              <dt className="text-text-muted">Provider</dt>
              <dd className="m-0">{agent.provider ? PROVIDER_LABEL[agent.provider] : '—'}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-text-muted">Model</dt>
              <dd className="m-0 font-mono text-code">{agent.model ?? '—'}</dd>
            </div>
          </dl>
        </>
      ) : (
        <Problems problems={agent.problems} />
      )}
      {open && openable ? (
        <div id={detailId} className="mt-1 border-t border-border pt-3">
          <AgentDetail agent={agent} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * The agents of the definitions Repository (at its last fetched commit) with the built-in
 * Default agents, then the base rules every Run gets first. The list is read again on window
 * focus and, through the Repository card's Fetch, when a fetch has ended.
 */
export function AgentList() {
  const { data, error, isPending, isError, isRefetching, refetch } = useAgents();
  // One agent is open at a time, keyed like the rows.
  const [openKey, setOpenKey] = useState<string>();

  if (isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading the agents"
        className="flex flex-col gap-3"
      >
        <Skeleton className="h-3.5 w-64 max-w-full" />
        <Skeleton className="h-3.5 w-40" />
      </div>
    );
  }
  if (isError) {
    return (
      <EmptyState
        tone="error"
        icon={TriangleAlertIcon}
        title="Couldn't load the agents"
        description={<span className="font-mono text-small">{readRequestOf(error)}</span>}
        action={
          <Button icon={RefreshCwIcon} loading={isRefetching} onClick={() => void refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const reason = repositoryReason(data);
  return (
    <>
      <Card aria-labelledby={TITLE_ID}>
        <CardHeader>
          <CardTitle id={TITLE_ID}>Agents</CardTitle>
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
              More agent folders exist than are listed here.
            </Banner>
          ) : null}
          <ul className="m-0 flex list-none flex-col p-0">
            {data.agents.map((agent) => (
              <AgentRow
                key={rowKey(agent)}
                agent={agent}
                open={openKey === rowKey(agent)}
                onToggle={() => setOpenKey(openKey === rowKey(agent) ? undefined : rowKey(agent))}
              />
            ))}
          </ul>
        </CardContent>
      </Card>
      <BaseRules version={data.baseRules.version} text={data.baseRules.text} />
    </>
  );
}
