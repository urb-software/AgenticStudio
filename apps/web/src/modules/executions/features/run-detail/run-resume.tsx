'use client';

import { PlayIcon } from 'lucide-react';
import { Banner } from '@/shared/components/banner';
import { Button } from '@/shared/ui/button';
import type { RunOutput } from '../../../../platform/api';
import { useResumeRun } from '../../api/runs-queries';
import { failedRequest } from '../../components/failed-request';

/** The request "Resume run" makes (generated `resumeRun`), shown when it fails. */
const RESUME_REQUEST = 'POST /api/runs/{runId}/resume';

/**
 * "Resume run" (Issue #105) on a Run stopped at the subscription's usage limit: the agent
 * worker continues the same agent session in the kept Working copy, with "Continue where you
 * stopped." as its next message. Shown only while the API says the Run is resumable.
 */
export function ResumeRun({ run }: { run: RunOutput }) {
  const resume = useResumeRun(run.id);
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="m-0 text-small text-text-muted">
        The agent's session and the Working copy are kept on the agent worker. Once the limit has
        reset, the run can continue where it stopped.
      </p>
      <Button icon={PlayIcon} loading={resume.isPending} onClick={() => resume.mutate()}>
        Resume run
      </Button>
      {resume.isError ? (
        <Banner tone="danger" title="Couldn't resume the run.">
          <span className="font-mono text-small">{failedRequest(RESUME_REQUEST, resume.error)}</span>
        </Banner>
      ) : null}
    </div>
  );
}
