import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The agent user's own Claude Code settings (review R4 of #129). The approved Mode keeps the
 * user setting source (`--setting-sources user`), so `~/.claude/settings.json` and
 * `~/.claude/settings.local.json` still load, and an agent could write them through Bash. Keys
 * that run code, change the login or billing, widen permissions or connect MCP servers there
 * would apply to every later Run, so before every Run step the worker refuses to start the CLI
 * while either file holds one of them; the operator reviews the file. Only key names are ever
 * reported, never values.
 */

/** Top-level keys of a user settings file that stop a Run step. */
export const FORBIDDEN_USER_SETTINGS = [
  'hooks',
  'env',
  'apiKeyHelper',
  'permissions',
  'mcpServers',
  'enabledMcpjsonServers',
  'awsAuthRefresh',
  'awsCredentialExport',
] as const;

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
    for (const key of FORBIDDEN_USER_SETTINGS) {
      if (Object.hasOwn(settings, key)) found.add(key);
    }
  }
  if (found.size > 0) {
    return `Claude Code user settings contain ${[...found].join(', ')}; the operator must review them.`;
  }
  if (unreadable.length > 0) {
    return `Claude Code user settings could not be checked (${unreadable.join(', ')}); the operator must review them.`;
  }
  return null;
}
