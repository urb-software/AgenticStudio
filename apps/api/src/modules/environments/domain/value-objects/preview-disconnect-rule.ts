export interface PreviewDisconnectRuleFacts {
  /** How many operations the Project has. */
  readonly operations: number;
  /** Whether any build was ever claimed by a controller. */
  readonly buildEverClaimed: boolean;
  /** The newest operation by request time, or `null` for none. */
  readonly newest: { kind: string; status: string } | null;
  /** How many operations are requested or claimed. */
  readonly activeOperations: number;
  /** A data removal is requested or claimed. */
  readonly removalActive: boolean;
}

/** What removing a Project's Preview on Disconnect does next. */
export type PreviewDisconnectAction =
  'forget_settings' | 'forget_everything' | 'request_removal' | 'wait_for_removal';

/** The steps of backend.md section 7: nothing to remove, nothing ever ran, removed already, or remove it. */
export class PreviewDisconnectRule {
  private constructor() {}

  static create(): PreviewDisconnectRule {
    return new PreviewDisconnectRule();
  }

  next(facts: PreviewDisconnectRuleFacts): PreviewDisconnectAction {
    if (facts.operations === 0) return 'forget_settings';
    if (!facts.buildEverClaimed) return 'forget_everything';
    const { newest } = facts;
    if (
      newest !== null &&
      newest.kind === 'remove_data' &&
      newest.status === 'succeeded' &&
      facts.activeOperations === 0
    ) {
      return 'forget_everything';
    }
    return facts.removalActive ? 'wait_for_removal' : 'request_removal';
  }
}
