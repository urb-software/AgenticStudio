'use client';

import { PlayIcon } from 'lucide-react';
import { useId } from 'react';
import { Banner } from '@/shared/components/banner';
import { Button } from '@/shared/ui/button';
import type { RunOutput } from '../../../../platform/api';
import { useResumeRun } from '../../api/runs-queries';
import { failedRequest } from '../../components/failed-request';

/** The request "Resume run" makes (generated `resumeRun`), shown when it fails. */
const RESUME_REQUEST = 'POST /api/runs/{runId}/resume';

/**
 * "Resume run" (Issue #105) on a Run stopped at the subscription's usage limit, laid out like
 * the answer form of a waiting Run (#103): the operator's next action, as its own section. The
 * agent worker continues the same agent session in the kept Working copy, with "Continue where
 * you stopped." as the operator's message. Shown only while the API says the Run is resumable.
 */
export function ResumeRun({ run }: { run: RunOutput }) {
  const titleId = useId();
  const resume = useResumeRun(run.id);
  return (
    <section
      aria-labelledby={titleId}
      data-slot="resume-run"
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <h2 id={titleId} className="m-0 flex items-center gap-2 text-body font-semibold text-text">
        <PlayIcon aria-hidden="true" className="size-4" />
        Resume after the usage limit
      </h2>
      <p className="m-0 text-small text-text-muted">
        The agent&apos;s session and the Working copy are kept on the agent worker. Once the limit
        has reset, the run continues where it stopped, with &ldquo;Continue where you
        stopped.&rdquo; as your message to the agent.
      </p>
      {resume.isError ? (
        <Banner tone="danger" title="Couldn't resume the run.">
          <span className="font-mono text-small">{failedRequest(RESUME_REQUEST, resume.error)}</span>
        </Banner>
      ) : null}
      <div>
        <Button
          variant="primary"
          icon={PlayIcon}
          loading={resume.isPending}
          onClick={() => resume.mutate()}
        >
          Resume run
        </Button>
      </div>
    </section>
  );
}
