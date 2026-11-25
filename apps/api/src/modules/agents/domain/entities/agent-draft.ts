import {
  DraftFileNotFoundError,
  DraftNoBaseError,
  DraftPathConflictError,
  DraftPathNotWritableError,
  DraftPathTakenError,
} from '../errors/agent-draft-errors.js';
import { AgentDraftFile } from '../value-objects/agent-draft-file.js';
import { AgentDraftFileSize } from '../value-objects/agent-draft-file-size.js';
import { AgentDraftLimits } from '../value-objects/agent-draft-limits.js';
import { AgentDraftPath } from '../value-objects/agent-draft-path.js';
import type { AgentDraftData } from './agent-draft-data.js';
import type { AgentDraftBaseEntry } from './agent-draft-facts.js';
import type { AgentDraftDeleteFacts } from './agent-draft-delete-facts.js';
import type { AgentDraftMoveFacts } from './agent-draft-move-facts.js';
import type { AgentDraftRevertFacts } from './agent-draft-revert-facts.js';
import type { AgentDraftWriteFacts } from './agent-draft-write-facts.js';

type BaseKinds = ReadonlyMap<string, AgentDraftBaseEntry['kind']>;

/**
 * The operator's unpublished changes to the definitions Repository, against one base commit (the
 * one the first change was made against, dropped with the last). It reaches no agent. Every write
 * raises the version, and the last write wins.
 */
export class AgentDraft {
  private baseCommitValue: string | null;
  private versionValue: number;
  private readonly loadedVersionValue: number;
  private updatedAtValue: Date;
  private readonly changed: Map<string, AgentDraftFile>;
  private readonly limits = AgentDraftLimits.create();

  private constructor(data: AgentDraftData) {
    this.baseCommitValue = data.baseCommit;
    this.versionValue = data.version;
    this.loadedVersionValue = data.version;
    this.updatedAtValue = new Date(data.updatedAt);
    this.changed = new Map(
      data.files.map((file) => [file.path, AgentDraftFile.restore(file)] as const),
    );
  }

  /** The Draft before any write: no file, no base, version 0. */
  static empty(now: Date): AgentDraft {
    return new AgentDraft({ baseCommit: null, version: 0, updatedAt: now, files: [] });
  }

  static restore(data: AgentDraftData): AgentDraft {
    return new AgentDraft(data);
  }

  get baseCommit(): string | null {
    return this.baseCommitValue;
  }

  get version(): number {
    return this.versionValue;
  }

  /** The version this Draft was restored at: the store saves it only while that is still the stored one. */
  get loadedVersion(): number {
    return this.loadedVersionValue;
  }

  get updatedAt(): Date {
    return this.updatedAtValue;
  }

  /** The changed files in path order. */
  get files(): readonly AgentDraftFile[] {
    return [...this.changed.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
  }

  fileAt(path: string): AgentDraftFile | null {
    return this.changed.get(path) ?? null;
  }

  /**
   * Stores a file's content: a base file becomes modified, any other path added. A refused write
   * changes nothing. Throws {@link DraftPathNotWritableError}, {@link DraftPathConflictError},
   * {@link DraftNoBaseError} and the limit and path errors.
   */
  put(facts: AgentDraftWriteFacts): void {
    const path = AgentDraftPath.of(facts.path);
    const size = AgentDraftFileSize.of(facts.size);
    const base = this.baseKindsOf(facts.baseEntries);
    const baseKind = base.get(path.value);
    if (baseKind !== undefined && baseKind !== 'file') {
      throw new DraftPathNotWritableError(path.value);
    }
    this.assertNoConflict(path.value, this.changed, base);
    const earlier = this.changed.get(path.value);
    const kept = earlier && !earlier.isDeleted ? earlier.movedFrom : null;
    const file = (baseKind === 'file' ? AgentDraftFile.modified : AgentDraftFile.added)({
      path,
      size,
      movedFrom: kept,
      now: facts.now,
    });
    this.commit(this.with(this.changed, [file]), facts);
  }

  /**
   * Marks the path deleted in one step: an added file simply goes, a modified one becomes deleted,
   * a base file is marked deleted. Throws {@link DraftFileNotFoundError} (also for a file the
   * Draft already deletes), {@link DraftPathNotWritableError} and the base and limit errors.
   */
  delete(facts: AgentDraftDeleteFacts): void {
    const path = AgentDraftPath.of(facts.path);
    const next = new Map(this.changed);
    const earlier = next.get(path.value);
    if (earlier) {
      if (earlier.isDeleted) throw new DraftFileNotFoundError(path.value);
      if (earlier.change === 'added') next.delete(path.value);
      else next.set(path.value, AgentDraftFile.removed({ path, now: facts.now }));
      this.commit(next, facts);
      return;
    }
    const baseKind = this.baseKindsOf(facts.baseEntries).get(path.value);
    if (baseKind === undefined) throw new DraftFileNotFoundError(path.value);
    if (baseKind !== 'file') throw new DraftPathNotWritableError(path.value);
    this.commit(this.with(next, [AgentDraftFile.removed({ path, now: facts.now })]), facts);
  }

  /**
   * Moves a file: the old path is dropped (only the Draft held it) or deleted, the new one added
   * and linked back by `movedFrom`. Throws what put and delete throw, and
   * {@link DraftPathTakenError} for a file at the new path that the Draft does not delete.
   */
  move(facts: AgentDraftMoveFacts): void {
    const from = AgentDraftPath.of(facts.from);
    const to = AgentDraftPath.of(facts.to);
    const size = AgentDraftFileSize.of(facts.size);
    const base = this.baseKindsOf(facts.baseEntries);

    const source = this.changed.get(from.value);
    const sourceKind = base.get(from.value);
    if (source?.isDeleted || (!source && sourceKind === undefined)) {
      throw new DraftFileNotFoundError(from.value);
    }
    if (!source && sourceKind !== 'file') throw new DraftPathNotWritableError(from.value);

    const targetKind = base.get(to.value);
    if (targetKind !== undefined && targetKind !== 'file') {
      throw new DraftPathNotWritableError(to.value);
    }
    if (this.exists(to.value, base)) throw new DraftPathTakenError(to.value);

    const next = new Map(this.changed);
    if (source?.change === 'added') next.delete(from.value);
    else next.set(from.value, AgentDraftFile.removed({ path: from, now: facts.now }));
    this.assertNoConflict(to.value, next, base);
    const movedFrom = source?.change === 'added' ? source.movedFrom : from.value;
    const file = (targetKind === 'file' ? AgentDraftFile.modified : AgentDraftFile.added)({
      path: to,
      size,
      movedFrom,
      now: facts.now,
    });
    this.commit(this.with(next, [file]), facts);
  }

  /**
   * Drops the Draft's change at the path, so the file is as the base commit has it: an added file
   * goes, a modified one reverts, a deleted one comes back. A moved file's new path goes and its
   * original, when the Draft deletes it, comes back. Throws {@link DraftFileNotFoundError}.
   */
  revert(facts: AgentDraftRevertFacts): void {
    const path = AgentDraftPath.of(facts.path);
    const earlier = this.changed.get(path.value);
    if (!earlier) throw new DraftFileNotFoundError(path.value);
    const next = new Map(this.changed);
    next.delete(path.value);
    if (earlier.movedFrom !== null && next.get(earlier.movedFrom)?.isDeleted) {
      next.delete(earlier.movedFrom);
    }
    this.commit(next, { currentCommit: null, now: facts.now });
  }

  /** Drops every change and the base. */
  discard(now: Date): void {
    this.changed.clear();
    this.baseCommitValue = null;
    this.versionValue += 1;
    this.updatedAtValue = now;
  }

  /** The Draft as storage holds it; only the repository's implementation reads it. */
  toData(): AgentDraftData {
    return {
      baseCommit: this.baseCommitValue,
      version: this.versionValue,
      updatedAt: this.updatedAtValue,
      files: this.files.map((file) => file.toData()),
    };
  }

  private baseKindsOf(entries: readonly AgentDraftBaseEntry[]): BaseKinds {
    return new Map(entries.map((entry) => [entry.path, entry.kind]));
  }

  private with(
    files: ReadonlyMap<string, AgentDraftFile>,
    added: readonly AgentDraftFile[],
  ): Map<string, AgentDraftFile> {
    const next = new Map(files);
    for (const file of added) next.set(file.path, file);
    return next;
  }

  /** Whether a file is at the path now: the Draft's, or a base entry the Draft does not delete. */
  private exists(path: string, base: BaseKinds): boolean {
    const file = this.changed.get(path);
    return file ? !file.isDeleted : base.has(path);
  }

  /** The path may not be a file where a folder is, or a folder where a file is. */
  private assertNoConflict(
    path: string,
    files: ReadonlyMap<string, AgentDraftFile>,
    base: BaseKinds,
  ): void {
    const present = [
      ...[...base.keys()].filter((entry) => !files.get(entry)?.isDeleted),
      ...[...files.values()].filter((file) => !file.isDeleted).map((file) => file.path),
    ];
    const conflicting = present.some(
      (other) => other !== path && (other.startsWith(`${path}/`) || path.startsWith(`${other}/`)),
    );
    if (conflicting) throw new DraftPathConflictError(path);
  }

  /** Checks the limits and the base, then replaces the files and raises the version. */
  private commit(
    next: ReadonlyMap<string, AgentDraftFile>,
    facts: { currentCommit: string | null; now: Date },
  ): void {
    const base = next.size === 0 ? null : (this.baseCommitValue ?? facts.currentCommit);
    if (next.size > 0 && base === null) throw new DraftNoBaseError();
    this.limits.assertFits([...next.values()]);
    this.changed.clear();
    for (const [path, file] of next) this.changed.set(path, file);
    this.baseCommitValue = base;
    this.versionValue += 1;
    this.updatedAtValue = facts.now;
  }
}
