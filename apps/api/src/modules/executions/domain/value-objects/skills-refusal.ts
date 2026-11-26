/**
 * The reason a Run's skills fail the shared validation: skills, codes and paths only, never
 * content, and at most ten problems.
 */
export class SkillsRefusal {
  static readonly MAX_LISTED = 10;

  private constructor(readonly detail: string) {}

  static of(problems: readonly { skill: string; code: string; path: string }[]): SkillsRefusal {
    const listed = problems
      .slice(0, SkillsRefusal.MAX_LISTED)
      .map((item) => `${item.code} (${item.skill}${item.path === '' ? '' : `/${item.path}`})`);
    return new SkillsRefusal(`The agent's skills fail the validation: ${listed.join(', ')}.`);
  }
}
