/** Where Agent definitions live in the definitions Repository, and how a folder is judged. */
import { AGENT_INSTRUCTIONS_MAX_BYTES } from '@agentic-studio/contracts/providers';

/** The top-level folder holding one folder per agent: `agents/<name>/`. */
export const AGENTS_DIRECTORY = 'agents';

/** The entry file of an agent folder, relative to it. */
export const AGENT_ENTRY_FILE = 'AGENT.md';

/** The top-level folder holding one folder per skill: `skills/<name>/`. */
export const SKILLS_DIRECTORY = 'skills';

/** The entry file of a skill folder, relative to it. */
export const SKILL_ENTRY_FILE = 'SKILL.md';

/** A usable name: lower-case letters, digits and `-`, up to 64 characters, the same rule as skill names. */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Names Studio keeps for itself: the built-in Default agents (one per Provider) and
 * `definitions-repository`, which the agents API uses as a fixed path next to an agent's name.
 * A folder with one of these names is refused, so a name never means two things.
 */
export const RESERVED_AGENT_NAMES = [
  'default-claude-code',
  'default-codex',
  'definitions-repository',
] as const;

/** The description is one line of 1 to this many characters. */
export const DESCRIPTION_MAX_LENGTH = 500;

/** Longest instructions (the Markdown after the front matter), in UTF-8 bytes. */
export const MAX_INSTRUCTIONS_BYTES = AGENT_INSTRUCTIONS_MAX_BYTES;

/** Longest front matter (the text between the `---` lines), in UTF-8 bytes. */
export const MAX_FRONT_MATTER_BYTES = 8 * 1024;

/** Most files in one agent folder, the entry file included. */
export const MAX_FILES = 100;

/** Largest single file, in bytes. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Largest total size of all files in one agent folder, in bytes. */
export const MAX_FOLDER_BYTES = 5 * 1024 * 1024;

/** The keys an entry file may carry. `model` and `skills` are optional. */
export const KNOWN_KEYS = ['name', 'description', 'provider', 'model', 'skills'] as const;

/** An agent names at most this many skills. */
export const MAX_AGENT_SKILLS = 20;

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

/** The keys a skill's entry file may carry: the common skill format's harmless descriptive ones. */
export const SKILL_KNOWN_KEYS = [
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
] as const;

/**
 * Keys that ask a skill to run apart from the agent (a fork, another agent). They are refused for
 * skills in addition to FORBIDDEN_KEYS, with the same reason; agents are judged by FORBIDDEN_KEYS.
 */
export const SKILL_FORBIDDEN_KEYS = ['context', 'agent'] as const;

/** A skill's description is one line of 1 to this many characters, the common format's limit. */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/** The longest `license` or `compatibility` value, in characters. */
export const SKILL_TEXT_MAX_LENGTH = 500;

/** `metadata` holds at most this many entries, with keys and values up to these lengths. */
export const SKILL_METADATA_MAX_ENTRIES = 20;
export const SKILL_METADATA_MAX_KEY_LENGTH = 64;
export const SKILL_METADATA_MAX_VALUE_LENGTH = 256;

/**
 * Files an agent CLI discovers inside a skill folder: those of an agent folder, plus the entry
 * file of an agent. Only the skill's own entry file at the folder root is allowed.
 */
export const SKILL_CLI_DISCOVERED_FILES = [...CLI_DISCOVERED_FILES, 'AGENT.md'] as const;

/** Markdown file names (any case) that are read for shell lines. */
export const MARKDOWN_FILE = /\.(md|markdown)$/i;

/**
 * A CLI runs shell for an inline `!` plus backtick and for a fence opened with three backticks
 * and `!`; the `$` forms are refused too, as the start of syntax built from arguments at run time.
 */
export const SHELL_LINE = /!`|```!|~~~!|```\$|~~~\$|!\$/;
