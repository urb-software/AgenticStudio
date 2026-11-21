/** The Run branch of one Run: `agent/<slug>-r<first 8 hex digits of the Run id>`, never the integration branch. */
export class RunBranchRule {
  private constructor(
    private readonly shortId: string,
    private readonly integrationBranch: string,
  ) {}

  static of(runId: string, integrationBranch: string): RunBranchRule {
    return new RunBranchRule(runId.toLowerCase().slice(0, 8), integrationBranch);
  }

  accepts(branch: string): boolean {
    return (
      /^[0-9a-f]{8}$/.test(this.shortId) &&
      new RegExp(`^agent/[a-z0-9]+(?:-[a-z0-9]+)*-r${this.shortId}$`).test(branch) &&
      branch !== this.integrationBranch
    );
  }
}
