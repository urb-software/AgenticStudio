import type { PreviewFailureCode } from './preview-failure-code.js';
import type { PreviewRefusalFacts } from './preview-refusal-facts.js';

export interface PreviewOperationFailureData {
  code: PreviewFailureCode;
  detail: string;
  refusals: readonly PreviewRefusalFacts[];
}

/** Why an operation failed: a fixed code, a short redacted detail and, for a refused stack, every refusal. */
export class PreviewOperationFailure {
  static readonly DETAIL_MAX_LENGTH = 2000;
  static readonly REFUSALS_MAX = 100;

  private constructor(
    readonly code: PreviewFailureCode,
    readonly detail: string,
    readonly refusals: readonly PreviewRefusalFacts[],
  ) {}

  /** The detail is cut to {@link DETAIL_MAX_LENGTH} and the refusals to {@link REFUSALS_MAX}. */
  static of(
    code: PreviewFailureCode,
    detail: string,
    refusals: readonly PreviewRefusalFacts[] = [],
  ): PreviewOperationFailure {
    return new PreviewOperationFailure(
      code,
      detail.slice(0, PreviewOperationFailure.DETAIL_MAX_LENGTH),
      refusals.slice(0, PreviewOperationFailure.REFUSALS_MAX).map((refusal) => ({ ...refusal })),
    );
  }

  static restore(data: PreviewOperationFailureData): PreviewOperationFailure {
    return new PreviewOperationFailure(data.code, data.detail, data.refusals);
  }

  toData(): PreviewOperationFailureData {
    return { code: this.code, detail: this.detail, refusals: this.refusals };
  }
}
