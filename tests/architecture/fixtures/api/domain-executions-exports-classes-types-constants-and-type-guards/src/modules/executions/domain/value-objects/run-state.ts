export const RUN_STATES = ['queued', 'succeeded'] as const;
export type RunState = (typeof RUN_STATES)[number];

export function isFinalRunState(value: string): value is 'succeeded' {
  return value === 'succeeded';
}

export class RunLifecycle {
  private constructor(readonly state: RunState) {}

  static start(): RunLifecycle {
    return new RunLifecycle('queued');
  }

  get isFinal(): boolean {
    return isFinalRunState(this.state);
  }
}
