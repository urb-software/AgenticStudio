export class InvalidPreviewLimitsError extends Error {
  constructor(readonly limit: string) {
    super(`The Preview limit ${limit} is outside its bounds.`);
    this.name = 'InvalidPreviewLimitsError';
  }
}

export interface PreviewLimitsData {
  memoryMiB: number;
  cpuPercent: number;
  tasksMax: number;
  buildMinutes: number;
}

/** What a Preview build may use, copied onto the operation when it is requested. The controller protocol's bounds are pinned to these by a test. */
export class PreviewLimits {
  static readonly BOUNDS = {
    memoryMiB: { min: 128, max: 65_536 },
    cpuPercent: { min: 10, max: 6400 },
    tasksMax: { min: 64, max: 32_768 },
    buildMinutes: { min: 1, max: 120 },
  } as const;

  private constructor(
    readonly memoryMiB: number,
    readonly cpuPercent: number,
    readonly tasksMax: number,
    readonly buildMinutes: number,
  ) {}

  /** Throws {@link InvalidPreviewLimitsError}. */
  static of(data: PreviewLimitsData): PreviewLimits {
    for (const name of Object.keys(PreviewLimits.BOUNDS) as (keyof PreviewLimitsData)[]) {
      const { min, max } = PreviewLimits.BOUNDS[name];
      if (!Number.isInteger(data[name]) || data[name] < min || data[name] > max) {
        throw new InvalidPreviewLimitsError(name);
      }
    }
    return new PreviewLimits(data.memoryMiB, data.cpuPercent, data.tasksMax, data.buildMinutes);
  }

  /** Rebuilds limits the store holds, without validating again. */
  static restore(data: PreviewLimitsData): PreviewLimits {
    return new PreviewLimits(data.memoryMiB, data.cpuPercent, data.tasksMax, data.buildMinutes);
  }

  toData(): PreviewLimitsData {
    return {
      memoryMiB: this.memoryMiB,
      cpuPercent: this.cpuPercent,
      tasksMax: this.tasksMax,
      buildMinutes: this.buildMinutes,
    };
  }
}
