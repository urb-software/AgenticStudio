'use client';

import { useId, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import { inputClassName } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Skeleton } from '@/shared/ui/skeleton';
import { toast } from '@/shared/ui/sonner';
import { ApiError } from '../../../../platform/api';
import { useProjectRunAgents, useSetDefaultAgent } from '../../api/projects-queries';

const TITLE_ID = 'default-agent-card-title';

/** The value of the "None" choice: no default agent is named. */
const NONE = '';

/**
 * The agent a new Run of this project offers first. When that agent is no longer usable, the
 * built-in Default agent of its Provider is offered instead, and the New run dialog says why.
 */
export function DefaultAgentCard({
  projectId,
  defaultAgent,
}: {
  projectId: string;
  defaultAgent: string | null;
}) {
  const agents = useProjectRunAgents(projectId, true);
  const save = useSetDefaultAgent(projectId);
  const [picked, setPicked] = useState<string | null>(null);
  const selectId = useId();
  const reasonId = `${selectId}-reason`;
  const saved = defaultAgent ?? NONE;
  const choice = picked ?? saved;
  const problem = save.error instanceof ApiError ? save.error.problem : undefined;
  const reason = agents.data?.preselectedReason ?? null;
  // The saved default may have stopped being usable: it stays visible as such until changed.
  const unusable =
    saved !== NONE && agents.data && !agents.data.agents.some((agent) => agent.name === saved)
      ? saved
      : null;

  function submit() {
    save.mutate(
      { agent: choice === NONE ? null : choice },
      {
        onSuccess: () => {
          setPicked(null);
          toast.success('Default agent saved');
        },
      },
    );
  }

  return (
    <Card aria-labelledby={TITLE_ID}>
      <CardHeader>
        <CardTitle id={TITLE_ID}>Default agent</CardTitle>
      </CardHeader>
      <CardContent>
        {agents.isPending ? (
          <div role="status" aria-busy="true" aria-label="Loading the agents">
            <Skeleton className="h-[38px] w-full" />
          </div>
        ) : agents.isError ? (
          <div className="flex flex-col items-start gap-2">
            <p className="m-0 text-small text-run-failed">Couldn&apos;t load the agents.</p>
            <Button type="button" size="sm" onClick={() => void agents.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (choice !== saved && !save.isPending) submit();
            }}
          >
            <div className="flex flex-col">
              <Label htmlFor={selectId} className="mb-1.5">
                Agent offered first
              </Label>
              <select
                id={selectId}
                data-slot="select"
                className={cn(inputClassName, 'h-[38px]')}
                aria-describedby={reason ? reasonId : undefined}
                disabled={save.isPending}
                value={choice}
                onChange={(event) => {
                  save.reset();
                  setPicked(event.target.value);
                }}
              >
                <option value={NONE}>None (the built-in Default agent of the Provider)</option>
                {unusable ? <option value={unusable}>{unusable} (not usable)</option> : null}
                {agents.data.agents.map((agent) => (
                  <option key={agent.name} value={agent.name}>
                    {agent.name}
                  </option>
                ))}
              </select>
              {reason ? (
                <p
                  id={reasonId}
                  data-testid="default-agent-reason"
                  className="mt-1.5 mb-0 text-small break-words whitespace-pre-wrap text-text-muted"
                >
                  {reason}
                </p>
              ) : null}
            </div>
            {save.error ? (
              <Banner tone="danger" title={problem?.title}>
                {problem?.detail || 'Could not save the default agent. Try again.'}
              </Banner>
            ) : null}
            <p className="m-0 text-small text-text-muted">
              New runs offer this agent first. If it is not usable when a run starts, the built-in
              Default agent is offered instead.
            </p>
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              <Button
                type="submit"
                variant="primary"
                loading={save.isPending}
                disabled={choice === saved}
              >
                {save.isPending ? 'Saving…' : 'Save default agent'}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
