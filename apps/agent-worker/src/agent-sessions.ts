import type { Provider } from '@agentic-studio/contracts';
import { lstat, readdir, rm } from 'node:fs/promises';
import { posix } from 'node:path';
import { isUuid } from './run-layout.js';

/** The agent session of a Run, as Studio recorded it (never read from the Working copy). */
export interface AgentSession {
  provider: Provider;
  ref: string;
}

/** Removes what the provider CLIs keep on the agent side for a Working copy (Issue #143). */
export interface AgentSessionFiles {
  remove(repoDir: string, session?: AgentSession): Promise<void>;
}

/**
 * Claude Code names a project's directory under `~/.claude/projects` after the working directory:
 * every character that is not a letter or digit becomes a dash.
 */
export function claudeProjectDirectoryName(repoDir: string): string {
  return repoDir.replace(/[^A-Za-z0-9]/g, '-');
}

const CODEX_SESSION_FILE = /^rollout-[0-9T:_-]+-([0-9a-f-]{36})\.jsonl$/i;

/**
 * The files the provider CLIs keep for a Run under the agent user's home directory (Issue #143),
 * removed together with the Run's Working copy so session history does not pile up:
 * - Claude Code: the directory `~/.claude/projects/<the Working copy's path, every character that
 *   is not a letter or digit as a dash>` (its session transcripts for that working directory);
 * - Codex: the session file `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<session id>.jsonl`
 *   of the Run's session id.
 * Nothing else is touched: not the logins, not other projects' or sessions' files, not
 * `~/.claude/settings*` or `~/.codex/config.toml` (Studio rewrites the Codex trust entries of the
 * Working copies that remain after every removal pass).
 *
 * Paths come only from the Working copy's path (derived from the Run id, validated as a UUID) and
 * the session id (accepted only as a UUID, the way both CLIs name sessions), joined onto
 * directories under `home`; each directory on the way must be a real directory, a symlink is
 * never followed (a link in place of the file or directory is removed itself), and a missing
 * file is no error.
 */
export class AgentSessions implements AgentSessionFiles {
  constructor(private readonly home: string) {
    if (!posix.isAbsolute(home) || home === '/') throw new Error('The home directory is not safe.');
  }

  async remove(repoDir: string, session?: AgentSession): Promise<void> {
    await this.removeClaudeProject(repoDir);
    if (session?.provider === 'codex' && isUuid(session.ref)) {
      await this.removeCodexSession(session.ref.toLowerCase());
    }
  }

  private async removeClaudeProject(repoDir: string): Promise<void> {
    if (!posix.isAbsolute(repoDir)) return;
    const projects = posix.join(this.home, '.claude', 'projects');
    if (!(await isRealDirectory(posix.dirname(projects)))) return;
    if (!(await isRealDirectory(projects))) return;
    const target = posix.join(projects, claudeProjectDirectoryName(repoDir));
    if (posix.dirname(target) !== projects || !(await exists(target))) return;
    // A symlink here is removed itself; `rm` never follows it.
    await rm(target, { recursive: true, force: true });
  }

  private async removeCodexSession(id: string): Promise<void> {
    const sessions = posix.join(this.home, '.codex', 'sessions');
    if (!(await isRealDirectory(posix.dirname(sessions)))) return;
    if (!(await isRealDirectory(sessions))) return;
    // <yyyy>/<mm>/<dd>: three levels of real directories with numeric names.
    let level = [sessions];
    for (const pattern of [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/]) {
      const next: string[] = [];
      for (const dir of level) {
        for (const name of await readNames(dir)) {
          const path = posix.join(dir, name);
          if (pattern.test(name) && (await isRealDirectory(path))) next.push(path);
        }
      }
      level = next;
    }
    for (const dir of level) {
      for (const name of await readNames(dir)) {
        const match = CODEX_SESSION_FILE.exec(name);
        if (match?.[1]?.toLowerCase() !== id) continue;
        const path = posix.join(dir, name);
        const stats = await lstat(path).catch(() => null);
        if (stats && !stats.isDirectory()) await rm(path, { force: true });
      }
    }
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  const stats = await lstat(path).catch(() => null);
  return stats !== null && stats.isDirectory() && !stats.isSymbolicLink();
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

async function readNames(dir: string): Promise<string[]> {
  return readdir(dir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
}
