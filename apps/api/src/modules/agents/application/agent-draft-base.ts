import { Inject, Injectable } from '@nestjs/common';
import { DEFINITIONS_FILES, type DefinitionsFiles } from '../../projects/contracts/index.js';
import {
  DraftBaseMissingError,
  DraftBaseUnreadableError,
  DraftNoBaseError,
} from '../domain/errors/agent-draft-errors.js';

/** What a change to the Draft takes from the Repository: the commit it holds now and the base tree. */
export interface AgentDraftBase {
  /** The commit the tree was read at: the Draft's base, or the current commit for an empty Draft. */
  commit: string;
  currentCommit: string | null;
  entries: { path: string; kind: 'file' | 'symlink' | 'submodule' | 'other' }[];
}

/**
 * Reads the tree a change to the Draft is judged against: the Draft's base commit, or the
 * Repository's current commit while the Draft is empty. A tree that cannot be read whole (not
 * Linux, no Clone, the commit is gone, or it was cut at its bound) is no base to judge against.
 */
@Injectable()
export class AgentDraftBaseReader {
  constructor(@Inject(DEFINITIONS_FILES) private readonly definitions: DefinitionsFiles) {}

  /** Throws `DraftNoBaseError`, `DraftBaseMissingError` and `DraftBaseUnreadableError`. */
  async read(baseCommit: string | null): Promise<AgentDraftBase> {
    const currentCommit = (await this.definitions.snapshot())?.commit ?? null;
    const commit = baseCommit ?? currentCommit;
    if (commit === null) throw new DraftNoBaseError();
    const tree = await this.definitions.listTree(commit, { whole: true });
    // The Draft's own base that the Clone no longer holds never comes back.
    if (tree.status === 'commit_missing' && baseCommit !== null) throw new DraftBaseMissingError();
    if (tree.status !== 'listed' || tree.truncated) throw new DraftBaseUnreadableError();
    return { commit, currentCommit, entries: tree.entries };
  }
}
