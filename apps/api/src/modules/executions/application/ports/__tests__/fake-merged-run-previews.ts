import type {
  MergedRun,
  MergedRunPreviews,
  PreviewOfMerge,
} from '../../../../environments/contracts/index.js';

/** A scripted {@link MergedRunPreviews}: it records the merges told and answers a set state. */
export class FakeMergedRunPreviews implements MergedRunPreviews {
  readonly merges: MergedRun[] = [];
  readonly reads: { projectId: string; runId: string; mergedCommit: string; mergedAt: Date }[] = [];
  answer: PreviewOfMerge = { state: 'not_started' };
  /** What both calls do instead of answering: `throws` rejects them. */
  mode: 'works' | 'throws' = 'works';

  merged(merge: MergedRun): Promise<void> {
    this.merges.push(merge);
    return this.mode === 'throws' ? Promise.reject(new Error('Preview down')) : Promise.resolve();
  }

  forMerge(
    projectId: string,
    runId: string,
    mergedCommit: string,
    mergedAt: Date,
  ): Promise<PreviewOfMerge> {
    this.reads.push({ projectId, runId, mergedCommit, mergedAt });
    return this.mode === 'throws'
      ? Promise.reject(new Error('Preview down'))
      : Promise.resolve(this.answer);
  }
}
