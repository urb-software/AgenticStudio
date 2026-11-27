type ProviderId = 'claude_code' | 'codex';

/** What the check needs of one phase: the state of its agent and that agent's Provider. */
interface PhaseUse {
  id: string;
  agentState: 'valid' | 'invalid' | 'missing';
  /** `null` while the agent is not valid. */
  provider: ProviderId | null;
}

interface ProviderState {
  id: ProviderId;
  name: string;
  available: boolean;
  reason?: string;
}

/** Whether a workflow can be chosen now, and which phase blocks it for a Provider reason. */
export class WorkflowUsability {
  private static readonly LABELS: Record<ProviderId, string> = {
    claude_code: 'Claude Code',
    codex: 'Codex',
  };

  private constructor(
    readonly usable: boolean,
    /** The Provider reason, naming each phase and Provider; `null` when none or not valid. */
    readonly reason: string | null,
    private readonly blocked: ReadonlySet<string>,
  ) {}

  /**
   * A workflow can be chosen when it is valid, which includes every phase's agent, and every
   * Provider its phases use is available. A Provider the list does not know is not available.
   */
  static of(
    valid: boolean,
    phases: readonly PhaseUse[],
    providers: readonly ProviderState[],
  ): WorkflowUsability {
    const blocked = new Set<string>();
    const sentences: string[] = [];
    for (const phase of phases) {
      if (phase.agentState !== 'valid' || phase.provider === null) {
        blocked.add(phase.id);
        continue;
      }
      const state = providers.find((provider) => provider.id === phase.provider);
      if (state?.available) continue;
      blocked.add(phase.id);
      const name = state?.name ?? WorkflowUsability.LABELS[phase.provider];
      const why = state?.reason ? `: ${state.reason}` : '';
      sentences.push(`The phase "${phase.id}" uses ${name}, which is not available${why}.`);
    }
    return new WorkflowUsability(
      valid && blocked.size === 0,
      valid && sentences.length > 0 ? sentences.join(' ') : null,
      blocked,
    );
  }

  isPhaseUsable(id: string): boolean {
    return !this.blocked.has(id);
  }
}
