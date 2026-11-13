import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { GitRequestRejectedError } from '../../../ports/repository-git.js';

/** A canonical, lowercase UUID: the only accepted project id. */
const PROJECT_ID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

/** Folder under the data directory that holds every Clone. */
export const CLONES_FOLDER = 'clones';

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

/**
 * Locations of Clones under the data directory, derived only from the project id:
 * `<dataDir>/clones/<projectId>.git`. A partial Clone is built next to it and renamed into
 * place when complete.
 */
export class ClonePaths {
  private readonly clonesDir: string;

  constructor(private readonly dataDir: string) {
    if (!isAbsolute(dataDir)) {
      throw new Error('The data directory must be an absolute path.');
    }
    this.clonesDir = join(resolve(dataDir), CLONES_FOLDER);
  }

  /** The Clone's path; rejects anything but a canonical UUID and any path outside the data directory. */
  clone(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) {
      throw new GitRequestRejectedError('The project id must be a canonical lowercase UUID.');
    }
    const path = resolve(this.clonesDir, `${projectId}.git`);
    if (!isInside(this.clonesDir, path)) {
      throw new GitRequestRejectedError('The Clone path escapes the data directory.');
    }
    return path;
  }

  /**
   * The Clone's path if it exists as a plain directory, `null` if it does not exist.
   * A symlink (or anything else) in its place is refused, never followed.
   */
  async existingClone(projectId: string): Promise<string | null> {
    const path = this.clone(projectId);
    if (!(await this.verifyClonesFolder())) return null;
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new GitRequestRejectedError('The Clone path is not a plain directory.');
    }
    return path;
  }

  /** A fresh partial-Clone path for the project, next to the final Clone. */
  partial(projectId: string): string {
    return `${this.clone(projectId)}.partial-${randomBytes(6).toString('hex')}`;
  }

  /** Whether `name` (an entry of the clones folder) is a partial Clone of the project. */
  isPartialOf(projectId: string, name: string): boolean {
    return name.startsWith(`${projectId}.git.partial-`);
  }

  get clonesFolder(): string {
    return this.clonesDir;
  }

  /**
   * Creates the clones folder if needed (owner-only) and checks that it is a real
   * directory inside the real data directory, so a symlink planted in its place cannot
   * redirect Clones elsewhere.
   */
  async ensureClonesFolder(): Promise<void> {
    await mkdir(this.clonesDir, { recursive: true, mode: 0o700 });
    await this.verifyClonesFolder();
  }

  /** Checks the clones folder without creating it; a missing folder is fine. */
  async verifyClonesFolder(): Promise<boolean> {
    let stats;
    try {
      stats = await lstat(this.clonesDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new GitRequestRejectedError('The clones folder is not a plain directory.');
    }
    const [realData, realClones] = await Promise.all([
      realpath(this.dataDir),
      realpath(this.clonesDir),
    ]);
    if (!isInside(realData, realClones)) {
      throw new GitRequestRejectedError('The clones folder escapes the data directory.');
    }
    return true;
  }
}
