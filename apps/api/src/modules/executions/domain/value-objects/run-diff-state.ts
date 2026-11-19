const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface RunDiffStateInput {
  resultTree: string;
  resultCommit: string;
  previousTree: string;
  previousCommit: string;
  pushedCommit?: string;
}

/**
 * Object ids only. Studio stores the pushed commit once, on the Run; the claim fills `pushedCommit`
 * from there, and what a worker sends with its diff state is not stored.
 */
export class RunDiffState {
  readonly resultTree: string;
  readonly resultCommit: string;
  readonly previousTree: string;
  readonly previousCommit: string;
  readonly pushedCommit?: string;

  private constructor(data: RunDiffStateInput) {
    this.resultTree = data.resultTree;
    this.resultCommit = data.resultCommit;
    this.previousTree = data.previousTree;
    this.previousCommit = data.previousCommit;
    if (data.pushedCommit !== undefined) this.pushedCommit = data.pushedCommit;
  }

  /** Throws when a field is not an object id. The contract checked the format; this checks again. */
  static of(input: RunDiffStateInput): RunDiffState {
    const ids = [
      input.resultTree,
      input.resultCommit,
      input.previousTree,
      input.previousCommit,
      ...(input.pushedCommit === undefined ? [] : [input.pushedCommit]),
    ];
    if (!ids.every((id) => OBJECT_ID.test(id))) {
      throw new Error('The diff state is not object ids.');
    }
    return new RunDiffState(input);
  }

  /** A state as storage holds it. */
  static restore(stored: RunDiffStateInput): RunDiffState {
    return new RunDiffState(stored);
  }

  toData(): RunDiffStateInput {
    return {
      resultTree: this.resultTree,
      resultCommit: this.resultCommit,
      previousTree: this.previousTree,
      previousCommit: this.previousCommit,
      ...(this.pushedCommit === undefined ? {} : { pushedCommit: this.pushedCommit }),
    };
  }
}
