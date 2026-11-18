/** The disk the agent worker keeps its Working copies and caches on, as it measured it. */
export interface WorkerDiskFigures {
  workingCopiesBytes: number;
  cachesBytes: number;
  keptRuns: number;
  freeBytes: number;
  totalBytes: number;
  minFreeBytes: number;
  /** Some files could not be read while measuring: the byte figures are lower bounds. */
  partial?: true;
}
