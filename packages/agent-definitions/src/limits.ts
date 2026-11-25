/** Where Agent definitions live in the definitions Repository, and how a folder is judged. */

/** The top-level folder holding one folder per agent: `agents/<name>/`. */
export const AGENTS_DIRECTORY = 'agents';

/** The entry file of an agent folder, relative to it. */
export const AGENT_ENTRY_FILE = 'AGENT.md';

/** A sibling place reserved for skills. It is ignored for now, like anything else at the top. */
export const RESERVED_SKILLS_DIRECTORY = 'skills';

/** A usable name: lower-case letters, digits and `-`, up to 64 characters, the same rule as skill names. */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The description is one line of 1 to this many characters. */
export const DESCRIPTION_MAX_LENGTH = 500;

/** Longest instructions (the Markdown after the front matter), in UTF-8 bytes. */
export const MAX_INSTRUCTIONS_BYTES = 64 * 1024;

/** Longest front matter (the text between the `---` lines), in UTF-8 bytes. */
export const MAX_FRONT_MATTER_BYTES = 8 * 1024;

/** Most files in one agent folder, the entry file included. */
export const MAX_FILES = 100;

/** Largest single file, in bytes. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Largest total size of all files in one agent folder, in bytes. */
export const MAX_FOLDER_BYTES = 5 * 1024 * 1024;

/** The keys an entry file may carry. `model` is optional. */
export const KNOWN_KEYS = ['name', 'description', 'provider', 'model'] as const;

/**
 * Keys that ask for tools, permissions, hooks, MCP servers, memory or isolation. A definition
 * never grants these; Studio decides them (security.md). A key is compared after lower-casing and
 * removing `-` and `_`, so spelling variants of these are caught too.
 */
export const FORBIDDEN_KEYS = [
  'tools',
  'allowed-tools',
  'allowedTools',
  'disallowedTools',
  'disallowed-tools',
  'permissions',
  'permissionMode',
  'permission-mode',
  'hooks',
  'mcpServers',
  'mcp-servers',
  'mcp',
  'memory',
  'isolation',
] as const;

/** The longest part of a key or path a problem repeats. */
export const MAX_QUOTED_LENGTH = 64;

/**
 * File names (compared case-insensitively, at any depth) that an agent CLI discovers as memory,
 * instructions or skills. Together with every path segment that starts with a dot, they are
 * refused: a definition carries no settings in any form.
 */
export const CLI_DISCOVERED_FILES = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'AGENTS.override.md',
  'SKILL.md',
] as const;
