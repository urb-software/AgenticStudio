import { createHash } from 'node:crypto';
import type {
  DefinitionsBlobIdsResult,
  DefinitionsBlobRead,
  DefinitionsBlobsResult,
  DefinitionsFileRead,
  DefinitionsFiles,
  DefinitionsFilesResult,
  DefinitionsSnapshot,
  DefinitionsTreeEntry,
  DefinitionsTreeResult,
  DefinitionsUnavailable,
  RepositoryState,
} from '../../../projects/contracts/index.js';

export const BASE_COMMIT = 'a'.repeat(40);
export const NEXT_COMMIT = 'b'.repeat(40);

/** What a fixture commit holds: a file's bytes (or text), an executable file, a link or a submodule. */
export type FakeCommitFile =
  string | Buffer | { executable: string } | { symlink: string } | { submodule: true };

const blobOf = (bytes: Buffer) =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

const bytesOf = (file: FakeCommitFile): Buffer | null =>
  typeof file === 'string'
    ? Buffer.from(file)
    : Buffer.isBuffer(file)
      ? file
      : 'executable' in file
        ? Buffer.from(file.executable)
        : null;

const isExecutable = (file: FakeCommitFile | undefined): boolean =>
  typeof file === 'object' && !Buffer.isBuffer(file) && 'executable' in file;

/** A scripted {@link DefinitionsFiles}: commits built from plain files, no Git. */
export class FakeDefinitionsFiles implements DefinitionsFiles {
  state: RepositoryState = 'ready';
  /** The commit the Repository holds now; null for a Repository with none. */
  head: string | null = BASE_COMMIT;
  connected = true;
  unavailable: DefinitionsUnavailable | null = null;
  truncated = false;
  readonly commits = new Map<string, Map<string, FakeCommitFile>>();
  listTreeCalls = 0;

  constructor(files: Record<string, FakeCommitFile> = {}) {
    this.commit(BASE_COMMIT, files);
  }

  commit(sha: string, files: Record<string, FakeCommitFile>): void {
    this.commits.set(sha, new Map(Object.entries(files)));
  }

  snapshot(): Promise<DefinitionsSnapshot | null> {
    return Promise.resolve(this.connected ? { state: this.state, commit: this.head } : null);
  }

  listTree(commit: string): Promise<DefinitionsTreeResult> {
    this.listTreeCalls += 1;
    if (this.unavailable) return Promise.resolve({ status: this.unavailable });
    const files = this.commits.get(commit);
    if (!files) return Promise.resolve({ status: 'commit_missing' });
    const entries = [...files]
      .map(([path, file]): DefinitionsTreeEntry => {
        const bytes = bytesOf(file);
        if (!bytes) {
          return {
            path,
            kind: typeof file === 'object' && 'symlink' in file ? 'symlink' : 'submodule',
            size: 0,
          };
        }
        return { path, kind: 'file', size: bytes.length, executable: isExecutable(file) };
      })
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    return Promise.resolve({ status: 'listed', entries, truncated: this.truncated });
  }

  readFiles(
    commit: string,
    paths: readonly string[],
    maxBytes: number,
  ): Promise<DefinitionsFilesResult> {
    if (this.unavailable) return Promise.resolve({ status: this.unavailable });
    const files = this.commits.get(commit);
    if (!files) return Promise.resolve({ status: 'commit_missing' });
    return Promise.resolve({
      status: 'read',
      files: paths.map((path): DefinitionsFileRead => {
        const bytes = bytesOf(files.get(path) ?? { submodule: true });
        if (!bytes) return { path, status: 'missing', size: 0 };
        if (bytes.length > maxBytes) return { path, status: 'too_large', size: bytes.length };
        const binary = bytes.includes(0) || !isUtf8(bytes);
        return {
          path,
          status: 'found',
          text: new TextDecoder().decode(bytes),
          size: bytes.length,
          binary,
        };
      }),
    });
  }

  readBlobs(
    commit: string,
    paths: readonly string[],
    maxBytes: number,
  ): Promise<DefinitionsBlobsResult> {
    if (this.unavailable) return Promise.resolve({ status: this.unavailable });
    const files = this.commits.get(commit);
    if (!files) return Promise.resolve({ status: 'commit_missing' });
    return Promise.resolve({
      status: 'read',
      files: paths.map((path): DefinitionsBlobRead => {
        const bytes = bytesOf(files.get(path) ?? { submodule: true });
        if (!bytes) return { path, status: 'missing' };
        if (bytes.length > maxBytes) return { path, status: 'too_large' };
        return { path, status: 'found', bytes: new Uint8Array(bytes) };
      }),
    });
  }

  blobIds(commit: string, paths: readonly string[]): Promise<DefinitionsBlobIdsResult> {
    if (this.unavailable) return Promise.resolve({ status: this.unavailable });
    const files = this.commits.get(commit);
    if (!files) return Promise.resolve({ status: 'commit_missing' });
    return Promise.resolve({
      status: 'read',
      blobs: paths.map((path) => {
        const bytes = bytesOf(files.get(path) ?? { submodule: true });
        return {
          path,
          blob: bytes ? blobOf(bytes) : null,
          executable: isExecutable(files.get(path)),
        };
      }),
    });
  }
}

function isUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
