'use client';

import { Banner } from '@/shared/components/banner';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { ApiError } from '../../../../platform/api';
import { useProviders } from '../../api/agents-queries';

const TITLE_ID = 'provider-models-title';
const READ_REQUEST = 'GET /api/providers';

function readRequestOf(error: unknown): string {
  if (!(error instanceof ApiError) || error.status === 0) return READ_REQUEST;
  const status = [error.status, error.problem?.title].filter(Boolean).join(' ');
  return `${READ_REQUEST} · ${status}`;
}

/**
 * The models an agent may name for each Provider, read-only: the operator writes one of these as
 * `model` in an AGENT.md. `default` names the CLI's own default. A failed read leaves the rest of
 * the page alone.
 */
export function ProviderModels() {
  const { data, error, isPending, isError, isRefetching, refetch } = useProviders();
  return (
    <Card aria-labelledby={TITLE_ID}>
      <CardHeader>
        <div className="flex flex-col gap-1">
          <CardTitle id={TITLE_ID}>Models</CardTitle>
          <CardDescription>
            Read-only. An agent names one of these as <code className="text-code">model</code> in
            its AGENT.md; <code className="text-code">default</code> is the CLI’s own default.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div role="status" aria-busy="true" aria-label="Loading the models">
            <Skeleton className="h-3.5 w-64 max-w-full" />
          </div>
        ) : isError ? (
          <Banner
            tone="danger"
            title="Couldn't load the models"
            action={
              <Button loading={isRefetching} onClick={() => void refetch()}>
                Retry
              </Button>
            }
          >
            <span className="font-mono text-small">{readRequestOf(error)}</span>
          </Banner>
        ) : (
          <div className="flex flex-col gap-3">
            {data.map((provider) => (
              <div
                key={provider.id}
                role="group"
                aria-label={provider.name}
                className="flex flex-col gap-1.5"
              >
                <span aria-hidden="true" className="text-small text-text-muted">
                  {provider.name}
                </span>
                <ul role="list" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
                  {provider.models.map((model) => (
                    <li key={model} className="font-mono text-code">
                      {model}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
