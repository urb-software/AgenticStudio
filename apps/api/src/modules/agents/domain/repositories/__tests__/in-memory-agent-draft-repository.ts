import { AgentDraft } from '../../entities/agent-draft.js';
import { DraftChangedConcurrentlyError } from '../../errors/agent-draft-errors.js';
import type { AgentDraftRepository } from '../agent-draft-repository.js';

export class InMemoryAgentDraftRepository implements AgentDraftRepository {
  stored = AgentDraft.empty(new Date('2026-11-25T09:00:00.000Z')).toData();
  readonly contents = new Map<string, Uint8Array>();
  saves = 0;
  /** The next saves that lose a race: another write got in first. */
  conflicts = 0;

  find(): Promise<AgentDraft> {
    return Promise.resolve(AgentDraft.restore(this.stored));
  }

  save(draft: AgentDraft, contents: ReadonlyMap<string, Uint8Array>): Promise<void> {
    if (this.conflicts > 0) {
      this.conflicts -= 1;
      this.stored = { ...this.stored, version: this.stored.version + 1 };
    }
    if (this.stored.version !== draft.loadedVersion) {
      return Promise.reject(new DraftChangedConcurrentlyError());
    }
    this.stored = draft.toData();
    // A deleted file keeps no bytes, as in the table.
    const kept = new Set(
      this.stored.files.filter((file) => file.change !== 'deleted').map((file) => file.path),
    );
    for (const path of [...this.contents.keys()]) {
      if (!kept.has(path)) this.contents.delete(path);
    }
    for (const [path, bytes] of contents) this.contents.set(path, bytes);
    this.saves += 1;
    return Promise.resolve();
  }

  findContent(path: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.contents.get(path) ?? null);
  }

  findContents(paths: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>> {
    return Promise.resolve(
      new Map(
        paths.flatMap((path) =>
          this.contents.has(path) ? [[path, this.contents.get(path)!] as const] : [],
        ),
      ),
    );
  }
}
