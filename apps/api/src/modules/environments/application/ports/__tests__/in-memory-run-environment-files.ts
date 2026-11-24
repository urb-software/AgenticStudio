import type { EnvironmentFile } from '@agentic-studio/contracts';
import type { RunEnvironmentFiles } from '../../../../projects/contracts/index.js';

/** A scripted {@link RunEnvironmentFiles}: the file each Project holds, or none. */
export class InMemoryRunEnvironmentFiles implements RunEnvironmentFiles {
  readonly files = new Map<string, EnvironmentFile>();
  failWith: Error | undefined;

  forProject(projectId: string): Promise<EnvironmentFile | null> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.files.get(projectId) ?? null);
  }
}
