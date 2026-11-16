import type { RunPayload } from '@agentic-studio/contracts';

/** `agent/<slug>-r<first 8 hex digits of the Run id>` of this Run, and not its integration branch. */
export function isRunBranchOf(
  branch: string,
  run: Pick<RunPayload, 'runId' | 'integrationBranch'>,
): boolean {
  const id8 = run.runId.toLowerCase().slice(0, 8);
  return (
    new RegExp(`^agent/[a-z0-9]+(?:-[a-z0-9]+)*-r${id8}$`).test(branch) &&
    branch !== run.integrationBranch
  );
}
