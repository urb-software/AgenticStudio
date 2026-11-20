import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  presentUserLevelFiles,
  type UserLevelFiles,
  userLevelFilesProblem,
} from '../user-level-files.js';

/**
 * The approved Mode keeps the user setting source (`--setting-sources user`), so these files still
 * load and could hold hooks, env, an API key helper or MCP servers: both must be absent or hold
 * only `$schema`, else the step is refused. Only key names are reported, never values.
 */

/** User-level files that must be absent, relative to the home directory. */
export const CLAUDE_USER_LEVEL_FILES: UserLevelFiles = {
  absent: ['.claude/CLAUDE.md'],
  empty: [
    { path: '.claude/agents' },
    { path: '.claude/commands' },
    { path: '.claude/rules' },
    // Created by the CLI at sign-in: skills synced from the operator's account, and its bin.
    { path: '.claude/skills', allowed: ['synced', '.trash'] },
  ],
};

/** The only top-level key a user settings file may hold. */
export const ALLOWED_USER_SETTINGS: readonly string[] = ['$schema'];

/** The user settings files, relative to the agent user's home directory. */
export const USER_SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];

/**
 * Why the user settings stop a Run step, or `null` when they do not. A missing file is fine; a
 * file (or a symbolic link to one) that is not a JSON object cannot be checked and stops the
 * step too.
 */
export async function userSettingsProblem(home: string | undefined): Promise<string | null> {
  if (!home) return null;
  const found = new Set<string>();
  const unreadable: string[] = [];
  for (const file of USER_SETTINGS_FILES) {
    let text: string;
    try {
      text = await readFile(join(home, file), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      unreadable.push(`~/${file}`);
      continue;
    }
    let settings: unknown;
    try {
      settings = JSON.parse(text);
    } catch {
      unreadable.push(`~/${file}`);
      continue;
    }
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      unreadable.push(`~/${file}`);
      continue;
    }
    for (const key of Object.keys(settings)) {
      if (!ALLOWED_USER_SETTINGS.includes(key)) found.add(key);
    }
  }
  if (found.size > 0) {
    return `Claude Code user settings contain ${[...found].join(', ')}; the operator must review them.`;
  }
  if (unreadable.length > 0) {
    return `Claude Code user settings could not be checked (${unreadable.join(', ')}); the operator must review them.`;
  }
  // User-level instructions, agents, commands and skills load in every Run.
  return userLevelFilesProblem(
    'Claude Code',
    await presentUserLevelFiles(home, CLAUDE_USER_LEVEL_FILES),
  );
}
