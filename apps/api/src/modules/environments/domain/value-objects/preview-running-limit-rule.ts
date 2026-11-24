import type { PreviewStateName } from './preview-state.js';

export interface PreviewRunningLimitRuleFacts {
  /** The newest operation that changes what runs. */
  readonly runningChange: { kind: string; status: string } | null;
  /** A build is requested or claimed. */
  readonly buildActive: boolean;
}

/**
 * Which Projects take a place of the running limit: a Preview that runs or a build that is
 * requested or claimed. The store's `findOccupyingProjects` statement follows it, which a test proves.
 */
export class PreviewRunningLimitRule {
  private constructor() {}

  static create(): PreviewRunningLimitRule {
    return new PreviewRunningLimitRule();
  }

  occupies(facts: PreviewRunningLimitRuleFacts): boolean {
    return this.state(facts) !== null;
  }

  /** `building` takes precedence over `running`; `null` when the Project takes no place. */
  state(
    facts: PreviewRunningLimitRuleFacts,
  ): Extract<PreviewStateName, 'building' | 'running'> | null {
    if (facts.buildActive) return 'building';
    const change = facts.runningChange;
    return change !== null && change.kind === 'build' && change.status === 'succeeded'
      ? 'running'
      : null;
  }
}
