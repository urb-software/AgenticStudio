# @agentic-studio/agent-definitions

The format of an Agent definition and of a Skill definition, and their validation. One pure package, shared by the API and the web app: it imports only `yaml`, its own files and `@agentic-studio/contracts/providers`, reads no file system and starts no process. The format is also described in `docs/architecture/backend.md` (the `agents` module).

## Format

- An agent is the folder `agents/<name>/` of the definitions Repository. The entry file is `agents/<name>/AGENT.md`. Skills are judged separately (see Skill format); anything else outside `agents/` and `skills/` is ignored.
- `AGENT.md` is UTF-8 text: YAML front matter between two `---` lines, then the instructions in Markdown.
- Required keys: `name` (matches `AGENT_NAME_PATTERN`, equals the folder name and is not one of `RESERVED_AGENT_NAMES`, the names Studio keeps: the built-in Default agents and `definitions-repository`: `name_reserved`), `description` (one line of 1 to 500 characters, no control character) and `provider` (one of `PROVIDERS`). Optional: `model`, default `default`, which must be in `PROVIDER_MODELS[provider]`.
- Optional `skills`: a YAML list of skill names (at most `MAX_AGENT_SKILLS`, 20). Without it the agent names no skill and is judged as before. Reasons: `skills_invalid` (not a list of text), `skill_name_invalid` (fails `AGENT_NAME_PATTERN`; names are compared exactly, so case variants are invalid), `skill_listed_twice`, `too_many_skills`. `checkAgentSkills(definition, skills)` is the pure cross-check against the skills that exist at the same commit (`ReadonlyMap<name, { valid }>`; a name absent from the map is `skill_missing`, one with `valid: false` is `skill_invalid`, each quoting the skill name as the key). `agentSkillNames(entryText)` reads the listed names of any entry file, valid or not.
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

## Workflow format

- A workflow is the folder `workflows/<name>/` ([ADR 0007](../../docs/architecture/adr/0007-workflows.md)); the only file is `WORKFLOW.md` (any other file is `workflow_extra_file`). Front matter, then an optional Markdown body for the operator (`documentation`: bounded like instructions, never handed to an agent, refused if it holds a `SHELL_LINE`). Path, kind and size rules, `cli_config_path` and dot segments are those of a skill folder.
- Keys (`WORKFLOW_KNOWN_KEYS`): `name` (agent name pattern, equals the folder name, not reserved), `description` (agent rules), `send-backs` (optional whole number 0 to `WORKFLOW_DEFAULT_SEND_BACKS` = 2, default 2; out of range is `send_backs_out_of_range`) and `sequence` (required list of at most `WORKFLOW_MAX_ITEMS` = 12 items, else `sequence_too_long`).
- An item is a mapping with `id` (agent name pattern, unique: `item_id_duplicate`) and `kind`: `work` or `review` (then `agent`, required, and `instructions`, optional text of at most 8 KiB, no shell line) or `checkpoint` (then `text`, required, at most 500 characters, no control character but newline). Any other key of an item is `unknown_key`, quoting the item id; a bad item is `item_invalid`.
- Order rules, each its own reason: `no_phase`, `review_first`, `review_before_work` (the first review has no work before it; not reported again when the review is the first item), `checkpoint_first`, `checkpoint_last`, `checkpoints_adjacent`.
- Forbidden keys at the top and in items: `FORBIDDEN_KEYS` (`forbidden_key`) and `WORKFLOW_FORBIDDEN_KEYS` (model, provider, skills, limits, Run limits, commands, env: `workflow_forbidden_key`), compared like the others.
- `checkWorkflowAgents(definition, agents)` is the pure cross-check against the agents at the same commit (`ReadonlyMap<name, { valid }>`): `phase_agent_missing` or `phase_agent_invalid`, naming the phase id and the agent. Provider enablement is not judged here. `WORKFLOW_PROBLEM_CODES` lists every reason; `PROBLEM_CODES` and `SKILL_PROBLEM_CODES` are unchanged.
- Phase instructions live in the front matter, so the 8 KiB front matter limit bounds them first; the 8 KiB check of an item stays as a second line.

## Use

```ts
const result = validateAgentFolder(name, entries); // { ok: true, definition } | { ok: false, problems }
const folders = findAgentFolders(repositoryEntries); // agents/<name>/ groups of a Repository tree
const problems = validateAgentFiles(entries); // the path, kind, duplicate and size rules alone
const skill = validateSkillFolder(name, entries); // the same shape, for skills/<name>/
const skills = findSkillFolders(repositoryEntries); // skills/<name>/ groups of a Repository tree
const workflow = validateWorkflowFolder(name, entries); // the same shape, for workflows/<name>/
const workflows = findWorkflowFolders(repositoryEntries); // workflows/<name>/ groups of a Repository tree
```

`entries` is `{ path, kind, size, content? }[]`, with paths relative to the folder. A refusal always holds at least one problem `{ code, path, key?, message }`. A message quotes at most the offending key or path, never a value or file content. `validateAgentFiles` judges the files without an entry file or a name (the agent worker applies it to the files Studio hands over, which leave `AGENT.md` out).

The package re-exports `PROVIDERS`, `PROVIDER_MODELS`, `MODEL_DEFAULT` and the `Provider` type, so the web app depends on this package only, never on the contracts.

Consumers use the parsed fields, above all `definition.instructions`, and never hand the raw `AGENT.md` to a CLI: a CLI's own parser may cut the front matter at a different line than this one does.
