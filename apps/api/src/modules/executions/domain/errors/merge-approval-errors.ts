import type { MergeRefusal } from '@agentic-studio/contracts';

/** `detail` is the Git host's redacted reason, for `host_refused` only. */
export class MergeRefusedError extends Error {
  constructor(
    readonly reason: MergeRefusal,
    readonly detail?: string,
  ) {
    super(`The pull request cannot be merged from Studio (${reason}).`);
    this.name = 'MergeRefusedError';
  }
}
