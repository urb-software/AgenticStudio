/** A review phase and the nearest work phase before it, which its changes go back to. */
export interface SendBackPath {
  /** The index of the review phase in the items. */
  review: number;
  /** The index of the work phase it goes back to. */
  target: number;
  /** The column the path is drawn in: the lowest one no overlapping path uses. */
  lane: number;
}

/** The send-back paths of a sequence, in order; a review with no work phase before it has none. */
export function sendBackPaths(items: readonly { kind: string }[]): SendBackPath[] {
  const paths: Omit<SendBackPath, 'lane'>[] = [];
  items.forEach((item, review) => {
    if (item.kind !== 'review') return;
    const before = items.slice(0, review).map((other) => other.kind);
    const target = before.lastIndexOf('work');
    if (target !== -1) paths.push({ review, target });
  });
  const placed: SendBackPath[] = [];
  for (const path of paths) {
    const taken = new Set(
      placed
        .filter((other) => other.target <= path.review && path.target <= other.review)
        .map((other) => other.lane),
    );
    let lane = 0;
    while (taken.has(lane)) lane += 1;
    placed.push({ ...path, lane });
  }
  return placed;
}

/** The sentence under a review phase: where "changes requested" goes and how often. */
export function sendBackSentence(target: string, limit: number): string {
  if (limit === 0) {
    return 'Changes requested are not sent back: this Workflow allows no send-back.';
  }
  return `Changes requested go back to ${target}, at most ${limit} ${limit === 1 ? 'time' : 'times'}.`;
}
