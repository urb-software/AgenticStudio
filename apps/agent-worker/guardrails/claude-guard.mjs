#!/usr/bin/env node
// Studio's PreToolUse hook for Claude Code (Issue #105) and Codex (Issue #134). GUARDRAIL, NOT
// THE SECURITY BOUNDARY: the boundary is the operating-system user with its rootless Docker
// daemon (ADR 0002, docs/engineering/security.md §2). A misled agent can get around these checks
// (an interpreter, an encoded command, a script it writes); they only stop the obvious mistakes
// early and say why.
//
// The server setup installs this file root-owned as
// /usr/local/lib/agentic-studio/guardrails/claude-guard.mjs (managed-files.txt); the CLIs'
// managed configuration runs it with /usr/local/bin/node (claude-managed-settings.json,
// codex-requirements.toml), so nothing from the repository or the agent user's files is ever
// executed as Studio's hook. The CLI passes the tool call as JSON on standard input; exit code 2
// blocks the call and shows the reason to the agent, exit code 0 leaves it to the permission
// rules. Codex sends shell commands as `Bash` and file edits as `apply_patch` (the patch in
// `command`), and the session's working directory as `cwd`.
//
// It blocks:
// - privilege escalation (sudo, su, doas, pkexec) and `git push` (the worker delivers, #102);
// - recursive deletes of the filesystem root or the home directory;
// - the system Docker daemon (its socket, `docker -H/--host`, `docker context`, `DOCKER_HOST=`);
// - file writes (Edit, MultiEdit, Write, NotebookEdit, Codex's apply_patch) outside the Working
//   copy and the Run step's temporary directory;
// - reading the CLIs' logins and other credentials in the agent user's home directory.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

const PRIVILEGED = new Set(['sudo', 'su', 'doas', 'pkexec']);
const ROOT_TARGETS = new Set([
  '/',
  '/*',
  '~',
  '~/',
  '~/*',
  '$HOME',
  '$HOME/',
  '$HOME/*',
  '${HOME}',
  '${HOME}/',
  '${HOME}/*',
]);
const CREDENTIAL_TEXT =
  /\.claude\/\.credentials|\.codex\/auth|\.git-credentials|\.ssh\/id_|\.config\/gh\/hosts/;
/** Credential locations under the home directory, as paths relative to it. */
const CREDENTIAL_PATHS = [
  '.claude/.credentials.json',
  '.codex',
  '.ssh',
  '.git-credentials',
  '.config/gh',
];
const DOCKER_SOCKETS = ['/var/run/docker.sock', '/run/docker.sock'];
const WRITING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** The command's simple commands: split at `;`, `&&`, `||`, `|`, `&` and line breaks. */
function segments(command) {
  return command
    .split(/;|&&|\|\||\||&|\n/)
    .map((part) => part.trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
}

/** The program of a simple command, past `env`, variable assignments and a path prefix. */
function program(tokens) {
  let i = 0;
  while (i < tokens.length && (tokens[i] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])))
    i++;
  return { name: posix.basename(tokens[i] ?? ''), args: tokens.slice(i + 1) };
}

function checkBash(command) {
  if (/docker\.sock/.test(command)) return 'the system Docker daemon is off limits';
  if (/(^|[\s;&|(])DOCKER_HOST=/.test(command)) {
    return 'the Docker daemon is fixed for the Run (no DOCKER_HOST=)';
  }
  if (CREDENTIAL_TEXT.test(command)) return 'logins and credentials are off limits';
  for (const tokens of segments(command)) {
    const { name, args } = program(tokens);
    if (PRIVILEGED.has(name)) return `${name} is not allowed (no privilege escalation)`;
    if (name === 'git' && args.includes('push')) {
      return 'git push is not allowed: the agent worker pushes the Run branch when the step ends';
    }
    if (name === 'docker' && args.some((arg) => /^(-H|--host)(=|$)/.test(arg))) {
      return 'the Docker daemon is fixed for the Run (no -H/--host)';
    }
    if (name === 'docker' && args[0] === 'context') return 'docker context is not allowed';
    if (name === 'rm') {
      const recursive = args.some((arg) => /^-[a-zA-Z]*[rR]/.test(arg) || arg === '--recursive');
      if (recursive && args.some((arg) => ROOT_TARGETS.has(arg))) {
        return 'deleting the root or the home directory is not allowed';
      }
    }
  }
  return null;
}

/** `path` with symbolic links of its existing part resolved (lexical for the rest). */
function real(path) {
  let existing = path;
  const rest = [];
  while (!existsSync(existing) && existing !== posix.dirname(existing)) {
    rest.unshift(posix.basename(existing));
    existing = posix.dirname(existing);
  }
  try {
    return posix.join(realpathSync(existing), ...rest);
  } catch {
    return path;
  }
}

/** The files a Codex patch adds, updates, deletes or moves to. */
function patchedFiles(patch) {
  const files = [];
  for (const line of patch.split('\n')) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line.trim());
    if (match) files.push(match[1].trim());
  }
  return files;
}

function inside(path, dir) {
  if (!dir) return false;
  const lexical = posix.resolve(dir);
  return [lexical, real(lexical)].some((base) => path === base || path.startsWith(`${base}/`));
}

/** Why a tool call on `target` is blocked, or `null`. */
function checkPath(tool, target, { project, home, tmp }) {
  const expanded = home && target.startsWith('~/') ? posix.join(home, target.slice(2)) : target;
  // As written and with symbolic links resolved: a link must not lead around a check.
  const lexical = posix.resolve(project ?? '/', expanded);
  const paths = [lexical, real(lexical)];
  if (paths.some((path) => DOCKER_SOCKETS.includes(path))) {
    return 'the system Docker daemon is off limits';
  }
  if (
    home &&
    paths.some((path) => CREDENTIAL_PATHS.some((entry) => inside(path, posix.join(home, entry))))
  ) {
    return 'logins and credentials are off limits';
  }
  if (
    WRITING_TOOLS.has(tool) &&
    !paths.every((path) => inside(path, project) || inside(path, tmp))
  ) {
    return 'files are written only inside the Working copy (or the temporary directory)';
  }
  return null;
}

/** A command given as words: a shell's script (`bash -lc '<script>'`) is the command itself. */
function commandText(words) {
  const flag = words.findIndex((word, i) => i > 0 && /^-[a-z]*c$/.test(word));
  const shell = /^(ba|z|da)?sh$/.test(posix.basename(words[0] ?? ''));
  return shell && flag > 0 && flag + 1 < words.length
    ? words.slice(flag + 1).join(' ')
    : words.join(' ');
}

/**
 * Whether Studio's guardrails block a tool call: the reason, or `null` to leave it to the
 * permission rules. `env` gives `CLAUDE_PROJECT_DIR` (the Working copy; Codex: the input's
 * `cwd`), `TMPDIR` (the Run step's temporary directory) and `HOME`.
 */
export function decide(input, env) {
  const tool = input?.tool_name;
  const toolInput = input?.tool_input ?? {};
  const where = { project: env.CLAUDE_PROJECT_DIR || input?.cwd, home: env.HOME, tmp: env.TMPDIR };
  const command = Array.isArray(toolInput.command)
    ? commandText(toolInput.command.filter((word) => typeof word === 'string'))
    : toolInput.command;
  if (tool === 'Bash') return typeof command === 'string' ? checkBash(command) : null;
  if (tool === 'apply_patch') {
    if (typeof command !== 'string') return null;
    for (const file of patchedFiles(command)) {
      const reason = checkPath('Write', file, where);
      if (reason !== null) return reason;
    }
    return null;
  }
  const target = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  if (typeof target !== 'string' || target === '') return null;
  return checkPath(tool, target, where);
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stderr.write("Blocked by Studio's guardrails: the tool call could not be read.\n");
    process.exit(2);
  }
  const reason = decide(input, process.env);
  if (reason !== null) {
    process.stderr.write(`Blocked by Studio's guardrails: ${reason}.\n`);
    process.exit(2);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
