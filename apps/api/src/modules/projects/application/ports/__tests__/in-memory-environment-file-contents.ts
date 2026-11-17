import { randomUUID } from 'node:crypto';
import type { EnvironmentFileContents } from '../environment-file-contents.js';

/**
 * In-memory {@link EnvironmentFileContents} for handler tests: contents by reference, with an
 * age in hours the test sets; `failWith` makes store and read reject (an unavailable store),
 * `failDiscards` keeps discarded contents (a delete that failed and was only logged).
 */
export class InMemoryEnvironmentFileContents implements EnvironmentFileContents {
  readonly values = new Map<string, string>();
  readonly old = new Set<string>();
  failWith: Error | undefined;
  failDiscards = false;

  store(content: string): Promise<string> {
    if (this.failWith) return Promise.reject(this.failWith);
    const reference = randomUUID();
    this.values.set(reference, content);
    return Promise.resolve(reference);
  }

  read(reference: string): Promise<string | null> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.values.get(reference) ?? null);
  }

  discard(reference: string): Promise<void> {
    if (!this.failDiscards) this.values.delete(reference);
    return Promise.resolve();
  }

  /** Marks every content stored so far as older than the grace period. */
  ageAll(): void {
    for (const reference of this.values.keys()) this.old.add(reference);
  }

  listOld(): Promise<string[]> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve([...this.old].filter((reference) => this.values.has(reference)));
  }
}
