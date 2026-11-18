#!/usr/bin/env node
// PreToolUse guardrail for Claude Code and Codex: it stops obvious mistakes early and is NOT the
// security boundary (the OS user with rootless Docker, ADR 0002). It runs with a cleared
// environment; exit code 2 blocks the call, exit code 0 leaves it to the permission rules.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { userInfo } from 'node:os';
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
    return 'files are written only inside the Working copy';
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
 * The reason a tool call is blocked, or `null` to leave it to the permission rules. `projectDir` is
 * the Working copy (Codex: `cwd`), `home` the passwd home; the step's `tmp` is beside the copy.
 */
export function decide(input, context) {
  const tool = input?.tool_name;
  const toolInput = input?.tool_input ?? {};
  const project = context.projectDir || input?.cwd;
  const where = {
    project,
    home: context.home,
    tmp: project ? posix.join(posix.dirname(posix.resolve(project)), 'tmp') : undefined,
  };
  const command = Array.isArray(toolInput.command)
    ? commandText(toolInput.command.filter((word) => typeof word === 'string'))
    : toolInput.command;
  if (tool === 'Bash') {
    if (typeof command !== 'string') return null;
    const reason = checkBash(command);
    if (reason !== null || !/^\s*apply_patch\b/.test(command)) return reason;
  }
  // A patch: Codex's apply_patch tool, or apply_patch run through its shell.
  if (tool === 'apply_patch' || tool === 'Bash') {
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
  // Never HOME or TMPDIR from the environment: the agent controls it.
  const reason = decide(input, {
    projectDir: process.env.CLAUDE_PROJECT_DIR,
    home: userInfo().homedir,
  });
  if (reason !== null) {
    process.stderr.write(`Blocked by Studio's guardrails: ${reason}.\n`);
    process.exit(2);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
