/**
 * Which agent a Run offers first: the Project's default when it is usable, otherwise the built-in
 * Default agent of Claude Code, with the reason when a named default could not be used.
 */
export class RunAgentPreselection {
  static readonly FALLBACK = 'default-claude-code';

  private constructor(
    readonly agent: string,
    readonly reason: string | null,
  ) {}

  /** `projectDefault` is the stored name, or `null` when the Project names none. */
  static of(
    candidates: readonly { name: string; usable: boolean }[],
    projectDefault: string | null,
  ): RunAgentPreselection {
    if (projectDefault === null) {
      return new RunAgentPreselection(RunAgentPreselection.FALLBACK, null);
    }
    const named = candidates.filter((candidate) => candidate.name === projectDefault);
    if (named.some((candidate) => candidate.usable)) {
      return new RunAgentPreselection(projectDefault, null);
    }
    const why = named.length === 0 ? 'no agent has this name' : 'its definition has problems';
    return new RunAgentPreselection(
      RunAgentPreselection.FALLBACK,
      `The default agent of this Project, ${projectDefault}, cannot be used now (${why}), so ` +
        'the Default agent of Claude Code is preselected.',
    );
  }
}
