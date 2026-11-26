# @agentic-studio/agent-definitions

The format of an Agent definition and of a Skill definition, and their validation. One pure package, shared by the API and the web app: it imports only `yaml`, its own files and `@agentic-studio/contracts/providers`, reads no file system and starts no process. The format is also described in `docs/architecture/backend.md` (the `agents` module).

## Format

- An agent is the folder `agents/<name>/` of the definitions Repository. The entry file is `agents/<name>/AGENT.md`. Skills are judged separately (see Skill format); anything else outside `agents/` and `skills/` is ignored.
- `AGENT.md` is UTF-8 text: YAML front matter between two `---` lines, then the instructions in Markdown.
- Required keys: `name` (matches `AGENT_NAME_PATTERN`, equals the folder name and is not one of `RESERVED_AGENT_NAMES`, the names Studio keeps: the built-in Default agents and `definitions-repository`: `name_reserved`), `description` (one line of 1 to 500 characters, no control character) and `provider` (one of `PROVIDERS`). Optional: `model`, default `default`, which must be in `PROVIDER_MODELS[provider]`.
- Any other key is `unknown_key`. A key that asks for tools, permissions, hooks, MCP servers, memory or isolation is `forbidden_key` (`FORBIDDEN_KEYS`).
- Limits (`limits.ts`): instructions 64 KiB, front matter 8 KiB, 100 files, 1 MiB per file, 5 MiB in total.
- Refused paths: absolute, `..`, empty and backslash segments, 8.3 short names (`short_name`, such as `PROGRA~1`), `.git` and its lookalikes, symbolic links and other non-file kinds, two paths that differ only in case.
- No CLI settings in any form: a path segment that starts with `.`, or a file named `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md` or `SKILL.md` (any case), is `cli_config_path`. Agent CLIs discover settings, hooks, MCP servers, skills and memory from these places, and a definition carries none.

## Skill format

- A skill is the folder `skills/<name>/`; the entry file is `SKILL.md` at its root. Same layout as an agent: front matter, then Markdown instructions.
- Keys: `name` (matches `AGENT_NAME_PATTERN` and equals the folder name) and `description` (one line, 1 to `SKILL_DESCRIPTION_MAX_LENGTH`, the common format's 1024) are required. Optional: `license` and `compatibility` (one line, up to 500 characters) and `metadata` (a flat mapping of at most 20 short text keys to text values). `SKILL_KNOWN_KEYS` lists them; any other key is `unknown_key`.
- `forbidden_key` covers `FORBIDDEN_KEYS` and also `SKILL_FORBIDDEN_KEYS` (`context`, `agent`, which ask for a fork). Agents are judged by `FORBIDDEN_KEYS` alone.
- The path, kind, size and count rules and the limits are those of an agent folder. `SKILL.md` is allowed only at the folder root; every name of `SKILL_CLI_DISCOVERED_FILES` (those of an agent folder plus `AGENT.md`, any case) anywhere else, and any dot segment, are `cli_config_path`.
- `shell_line`: a `SKILL.md`, or any other Markdown file (`.md`, `.markdown`), that matches `SHELL_LINE` (also in any decoded front matter value, so a YAML escape cannot hide it) (an inline `!` plus backtick, a fence opened with `!` or `$`, or `!$`) is refused. The caller must read the text of every Markdown file; one without text is `entry_unreadable`. In a skill folder a file with text is measured by it as well as by its declared size.

## Use

```ts
const result = validateAgentFolder(name, entries); // { ok: true, definition } | { ok: false, problems }
const folders = findAgentFolders(repositoryEntries); // agents/<name>/ groups of a Repository tree
const problems = validateAgentFiles(entries); // the path, kind, duplicate and size rules alone
const skill = validateSkillFolder(name, entries); // the same shape, for skills/<name>/
const skills = findSkillFolders(repositoryEntries); // skills/<name>/ groups of a Repository tree
```

`entries` is `{ path, kind, size, content? }[]`, with paths relative to the folder. A refusal always holds at least one problem `{ code, path, key?, message }`. A message quotes at most the offending key or path, never a value or file content. `validateAgentFiles` judges the files without an entry file or a name (the agent worker applies it to the files Studio hands over, which leave `AGENT.md` out).

The package re-exports `PROVIDERS`, `PROVIDER_MODELS`, `MODEL_DEFAULT` and the `Provider` type, so the web app depends on this package only, never on the contracts.

Consumers use the parsed fields, above all `definition.instructions`, and never hand the raw `AGENT.md` to a CLI: a CLI's own parser may cut the front matter at a different line than this one does.
