import type { ResumeReason } from './run-resume.js';
import type { RunFailure } from './run-failure.js';

interface HandOutBase {
  /** The commit a delivery or resume counts the integration merge from. */
  mergedIntegrationCommit?: string;
  pullRequestNumber?: number;
}

/** What a claimed Run hands to the worker. `refused` is a Run that cannot be handed out. */
export type RunHandOut =
  | ({ kind: 'deliver'; runBranch: string } & HandOutBase)
  | ({
      kind: 'resume';
      runBranch: string;
      sessionRef: string;
      answer: string;
      reason: ResumeReason;
      newEnvironmentFile: boolean;
      followUpNumber?: number;
      pendingUpdate?: { baseCommit: string; pushedCommit?: string };
      bringUpToDate?: { updateBase?: string; updateTip?: string };
    } & HandOutBase)
  | { kind: 'start' }
  | { kind: 'refused'; failure: RunFailure; as: 'delivery' | 'preparation' };
