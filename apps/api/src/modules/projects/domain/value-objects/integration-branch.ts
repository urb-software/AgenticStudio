export const INTEGRATION_BRANCH_MAX_LENGTH = 255;

/**
 * A valid Git branch name (`git check-ref-format --branch`) as one ECMAScript pattern, so the HTTP
 * schema publishes it as a form hint. Excludes `@`, leading `-`, `/` or `.`, `..`, `//`, `@{`, `/.`,
 * `.lock` components, trailing `/` or `.`, control characters, space, DEL, `~ ^ : ? * [`, backslash.
 */
export const INTEGRATION_BRANCH_PATTERN =
  // eslint-disable-next-line no-control-regex -- control characters are not allowed in refs
  /^(?!@$)(?![-/.])(?!.*(?:\.\.|\/\/|@\{|\/\.|\.lock\/|\.lock$|[/.]$))[^\x00-\x20\x7f~^:?*[\\]+$/;

export const INVALID_INTEGRATION_BRANCH_MESSAGE = 'Enter a valid branch name, e.g. dev.';

export class InvalidIntegrationBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIntegrationBranchError';
  }
}

export class IntegrationBranch {
  private constructor(readonly value: string) {}

  static parse(raw: string): IntegrationBranch {
    const value = raw.trim();
    if (value.length === 0)
      throw new InvalidIntegrationBranchError('Enter the integration branch.');
    if (value.length > INTEGRATION_BRANCH_MAX_LENGTH) {
      throw new InvalidIntegrationBranchError(
        `Use at most ${INTEGRATION_BRANCH_MAX_LENGTH} characters.`,
      );
    }
    if (!INTEGRATION_BRANCH_PATTERN.test(value)) {
      throw new InvalidIntegrationBranchError(INVALID_INTEGRATION_BRANCH_MESSAGE);
    }
    return new IntegrationBranch(value);
  }
}
