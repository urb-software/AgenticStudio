import type { PreviewServiceState } from './preview-service-state.js';

export interface PreviewOperationResultData {
  services: readonly PreviewServiceState[];
}

/** What the controller found running when an operation succeeded. */
export class PreviewOperationResult {
  static readonly SERVICES_MAX = 100;

  private constructor(readonly services: readonly PreviewServiceState[]) {}

  /** Keeps at most {@link SERVICES_MAX} services. */
  static of(services: readonly PreviewServiceState[]): PreviewOperationResult {
    return new PreviewOperationResult(
      services.slice(0, PreviewOperationResult.SERVICES_MAX).map((service) => ({ ...service })),
    );
  }

  static restore(data: PreviewOperationResultData): PreviewOperationResult {
    return new PreviewOperationResult(data.services);
  }

  toData(): PreviewOperationResultData {
    return { services: this.services };
  }
}
