'use client';

import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { Banner } from '@/shared/components/banner';
import { EmptyState } from '@/shared/components/empty-state';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { ApiError, type AgentSummaryOutput } from '../../../../platform/api';
import { useAgent } from '../../api/agents-queries';
import { skillHref } from '../../components/definitions-view';
import { formatSize } from '../../components/format-size';
import { Problems } from '../../components/problems';
import { PlainText } from '../../components/plain-text';

/**
 * One agent: its instructions as plain text and its other files with their sizes. The API answers
 * a built-in agent for a name a built-in agent has, so a refused folder of the same name has no
 * files to open here.
 */
export function AgentDetail({ agent }: { agent: AgentSummaryOutput }) {
  const query = useAgent(agent.name);

  if (query.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading the agent"
        className="flex flex-col gap-3"
      >
        <Skeleton className="h-3.5 w-64 max-w-full" />
        <Skeleton className="h-3.5 w-40" />
      </div>
    );
  }
  // An answer without `agent` is another route's (the client does not check shapes): not found.
  const missing = query.isSuccess && !query.data.agent;
  if (query.isError || missing) {
    const gone = missing || (query.error instanceof ApiError && query.error.status === 404);
    return (
      <EmptyState
        tone="error"
        icon={TriangleAlertIcon}
        title={gone ? 'This agent is no longer in the Repository' : "Couldn't load the agent"}
        description={
          <span className="font-mono text-small">
            GET /api/agents/{encodeURIComponent(agent.name)}
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

  const detail = query.data?.agent;
  if (!detail) return null;
  // A name that is missing or not a valid name leads nowhere: it is shown as text.
  const unresolved = new Set(
    detail.problems
      .filter((item) => item.code === 'skill_missing' || item.code === 'skill_name_invalid')
      .map((item) => item.key),
  );
  if (detail.source !== agent.source) {
    return (
      <Banner tone="info">
        A built-in agent has this name, so the files of this folder cannot be opened here.
      </Banner>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {detail.source === 'built_in' ? (
        <p className="m-0 text-small text-text-muted">
          A built-in agent has no instructions of its own: it runs with the base rules only.
        </p>
      ) : !detail.usable ? (
        // The API withholds the instructions of a refused folder.
        <div className="flex flex-col gap-2">
          <Banner tone="danger">
            This agent cannot be used until its problems are fixed. Its instructions are not shown.
          </Banner>
          <Problems problems={detail.problems} />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 text-small font-semibold">Instructions</h3>
          {detail.instructions === '' ? (
            <p className="m-0 text-small text-text-muted">
              The instructions of this agent are empty.
            </p>
          ) : (
            <PlainText text={detail.instructions} role="region" aria-label="Instructions text" />
          )}
        </div>
      )}
      {detail.skills.length > 0 ? (
        <section aria-label="Skills of this agent" className="flex flex-col gap-2">
          <h3 className="m-0 text-small font-semibold">Skills</h3>
          <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-small">
            {detail.skills.map((skill, index) => (
              <li key={`${index}:${skill}`}>
                {unresolved.has(skill) ? (
                  <code className="text-code break-all">{skill}</code>
                ) : (
                  <Link href={skillHref(skill)} className="font-mono text-code break-all">
                    {skill}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
