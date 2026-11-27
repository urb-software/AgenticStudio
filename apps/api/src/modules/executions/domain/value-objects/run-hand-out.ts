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
  | ({
      /** The next Phase of a Workflow Run, in the Working copy the Phase before left. */
      kind: 'next_phase';
      runBranch: string;
      /** With a Phase that has a session from an earlier round: continue it with `answer`. */
      session?: { sessionRef: string; answer: string; reason: ResumeReason };
      followUpNumber?: number;
    } & HandOutBase)
  | { kind: 'start' }
  | { kind: 'refused'; failure: RunFailure; as: 'delivery' | 'preparation' };
