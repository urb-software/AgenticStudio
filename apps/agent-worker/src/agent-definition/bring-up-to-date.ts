/**
 * What the agent is told after Studio's worker merged the integration branch into its Run branch
 * (Issue #147): the wording that goes with the built-in agent definition, kept apart from the Git
 * code that does the merge (review St7 of #154).
 */

/** How the merge started, as far as the wording needs it (the Git module's start result fits). */
export type UpdateOutcome =
  | { outcome: 'merged'; commit: string }
  | { outcome: 'conflicts'; commit: string; files: string[]; moreFiles: number };

/** A path for a message: one line, no control characters, not too long. */
export function printable(path: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = path.replace(/[\u0000-\u001f\u007f]/g, '?');
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}

/** The first characters of a commit id, for a sentence. */
export function shortId(commit: string): string {
  return commit.slice(0, 7);
}

/**
 * The instruction after a bring-up-to-date merge. `start.outcome` says whether the merge commit
 * already exists (no conflicts) or the merge is open with conflicts; `note` is the operator's own
 * words, if any, always shown as theirs.
 */
export function bringUpToDateInstruction(input: {
  integrationBranch: string;
  start: UpdateOutcome;
  note: string;
}): string {
  const { integrationBranch, start, note } = input;
  const target = `\`${integrationBranch}\` (commit ${shortId(start.commit)})`;
  const noteText = note.trim() === '' ? '' : `\n\nThe operator's note:\n\n${note.trim()}`;
  const never =
    'Do not rebase, reset, rewrite history or push; Studio pushes the branch itself, as an ordinary update of the Run branch.';
  if (start.outcome === 'merged') {
    return (
      `Studio merged the latest ${target} into this Run branch. The merge commit exists and ` +
      `nothing conflicted. Run the project's checks and fix whatever the update broke, in new ` +
      `commits on this branch. If nothing broke, change nothing. ${never}${noteText}`
    );
  }
  const listed = start.files.map((file) => `- ${printable(file)}`).join('\n');
  const more = start.moreFiles > 0 ? `\n- and ${start.moreFiles} more` : '';
  return (
    `Studio is merging the latest ${target} into this Run branch, and the merge has conflicts ` +
    `in these files:\n\n${listed}${more}\n\nThe working copy is in the middle of that merge. ` +
    `Resolve every conflict so that the result keeps what both sides meant, remove all conflict ` +
    `markers, then run the project's checks and fix whatever the update broke. You may stage the ` +
    `resolved files and complete the merge commit yourself; if you cannot run Git commands, ` +
    `leave the resolved text files in the working tree and Studio completes the merge for you. A ` +
    `conflict in a file that is not text (binary, deleted on one side, a link) is yours to ` +
    `decide: stage your choice with Git, or Studio aborts the merge. Do not abort the merge ` +
    `yourself. ${never}${noteText}`
  );
}
