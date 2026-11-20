'use client';

import { HardDriveIcon } from 'lucide-react';
import { useId } from 'react';
import { Banner } from '@/shared/components/banner';
import { Card } from '@/shared/ui/card';
import type { AgentWorkerDiskOutput } from '../../../../platform/api';
import { useAgentWorker } from '../../api/runs-queries';
import { formatBytes } from '../../components/format-bytes';

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-small text-text-muted">{label}</dt>
      <dd className="m-0 text-body font-medium text-text">{value}</dd>
    </div>
  );
}

function DiskCard({ disk }: { disk: AgentWorkerDiskOutput }) {
  const titleId = useId();
  // Some files could not be read while measuring: the byte figures are lower bounds.
  const atLeast = (value: string) => (disk.partial ? `at least ${value}` : value);
  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3">
      {disk.low ? (
        <Banner tone="warning" title="The agent worker's disk is nearly full">
          {formatBytes(disk.freeBytes)} are free, below the {formatBytes(disk.minFreeBytes)} it
          keeps free. New runs are not prepared and fail until space is freed; follow-ups and
          deliveries of existing runs go on. Working copies are removed by the retention rules (see
          the deployment guide).
        </Banner>
      ) : null}
      <Card className="flex flex-col gap-3 p-4">
        <h2 id={titleId} className="m-0 flex items-center gap-2 text-body font-semibold text-text">
          <HardDriveIcon aria-hidden="true" className="size-4" />
          Agent worker disk
        </h2>
        <dl className="m-0 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Figure label="Working copies" value={atLeast(formatBytes(disk.workingCopiesBytes))} />
          <Figure label="Caches" value={atLeast(formatBytes(disk.cachesBytes))} />
          <Figure label="Runs kept" value={String(disk.keptRuns)} />
          <Figure
            label="Free"
            value={`${formatBytes(disk.freeBytes)} of ${formatBytes(disk.totalBytes)}`}
          />
        </dl>
        {disk.partial ? (
          <p className="m-0 text-small text-text-muted">
            Some files could not be read while measuring, so the sizes are lower bounds.
          </p>
        ) : null}
      </Card>
    </section>
  );
}

export function AgentWorkerDisk() {
  const worker = useAgentWorker();
  if (!worker.data?.connected || !worker.data.disk) return null;
  return <DiskCard disk={worker.data.disk} />;
}
