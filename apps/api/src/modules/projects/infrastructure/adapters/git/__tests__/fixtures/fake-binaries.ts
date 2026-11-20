import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Stand-ins for `git` and `ssh` that record how the adapter starts them (arguments,
 * environment, working directory), so tests can assert the hardening at the process-spawn
 * boundary. They are shell scripts: Linux only, like the adapter.
 */

export interface Invocation {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** `/proc/self/limits` of the process, as it started. */
  limits: string;
}

export type FakeFetch = 'fail' | 'grow-and-hang' | 'occupy-target' | 'out-of-memory';

export async function writeFakeGit(
  dir: string,
  recordDir: string,
  options: { version?: string; fetch?: FakeFetch } = {},
): Promise<string> {
  const fetches: Record<FakeFetch, string> = {
    fail: 'echo "fatal: could not read from remote" >&2; exit 128',
    'grow-and-hang':
      'head -c 3000000 /dev/zero > "$gitdir/objects/pack/tmp_pack_fake"; exec sleep 30',
    'out-of-memory':
      'echo "fatal: Out of memory, malloc failed (tried to allocate 60000001 bytes)" >&2; exit 128',
    'occupy-target': 'mkdir -p "${gitdir%.partial-*}/objects"; exit 0',
  };
  const fetch = fetches[options.fetch ?? 'fail'];
  const script = `#!/bin/sh
rec='${recordDir}'
n=$(ls "$rec" | grep -c '^git-.*.args$')
printf '%s\\0' "$@" > "$rec/git-$n.args"
env -0 > "$rec/git-$n.env"
pwd > "$rec/git-$n.cwd"
cp /proc/self/limits "$rec/git-$n.limits"
gitdir=''
for a in "$@"; do case "$a" in --git-dir=*) gitdir="\${a#--git-dir=}";; esac; done
case " $* " in
  *" --version "*) echo "git version ${options.version ?? '2.43.0'}"; exit 0;;
  *" init "*) for a in "$@"; do last="$a"; done; mkdir -p "$last/objects/pack" "$last/refs/heads"; exit 0;;
  *" symbolic-ref "*) exit 0;;
  *" rev-parse "*) echo 0123456789abcdef0123456789abcdef01234567; exit 0;;
  *" fetch "*) ${fetch};;
esac
echo "fatal: unable to access 'https://user:hunter2@git.example.test/': The requested URL returned error: 403" >&2
echo "fatal: '$rec' does not appear to be a git repository" >&2
exit 128
`;
  return writeExecutable(join(dir, 'fake-git'), script);
}

/**
 * A stand-in for `prlimit` that records how it is started, then runs the real one: the bound
 * stays in force for whatever it starts.
 */
export async function writeFakePrlimit(dir: string, recordDir: string): Promise<string> {
  const script = `#!/bin/sh
rec='${recordDir}'
n=$(ls "$rec" | grep -c '^prlimit-.*.args$')
printf '%s\\0' "$@" > "$rec/prlimit-$n.args"
exec "$(command -v prlimit)" "$@"
`;
  return writeExecutable(join(dir, 'fake-prlimit'), script);
}

export async function prlimitInvocations(recordDir: string): Promise<string[][]> {
  const names = (await readdir(recordDir))
    .filter((name) => /^prlimit-\d+\.args$/.test(name))
    .sort((a, b) => parseInt(a.slice(8), 10) - parseInt(b.slice(8), 10));
  return Promise.all(
    names.map(async (name) =>
      (await readFile(join(recordDir, name), 'utf8')).split('\0').slice(0, -1),
    ),
  );
}

export type FakeSsh = 'deny' | 'hang';

export async function writeFakeSsh(
  dir: string,
  recordDir: string,
  behaviour: FakeSsh,
): Promise<string> {
  const end =
    behaviour === 'hang'
      ? 'exec sleep 30'
      : 'echo "git@git.example.test: Permission denied (publickey)." >&2; exit 255';
  const script = `#!/bin/sh
rec='${recordDir}'
printf '%s\\0' "$@" > "$rec/ssh.args"
env -0 > "$rec/ssh.env"
for a in "$@"; do
  case "$a" in
    IdentityFile=*) key="\${a#IdentityFile=}"; stat -c '%a' "$key" > "$rec/ssh.key-mode"; cp "$key" "$rec/ssh.key"; echo "$key" > "$rec/ssh.key-path";;
    UserKnownHostsFile=*) cp "\${a#UserKnownHostsFile=}" "$rec/ssh.known-hosts";;
  esac
done
${end}
`;
  return writeExecutable(join(dir, 'fake-ssh'), script);
}

/**
 * A fake `ssh-keyscan` that records its arguments and environment, then prints `stdout`
 * (known_hosts lines) and `stderr`, or hangs.
 */
export async function writeFakeKeyscan(
  dir: string,
  recordDir: string,
  behaviour: { stdout?: string; stderr?: string } | 'hang',
): Promise<string> {
  const output =
    behaviour === 'hang'
      ? 'exec sleep 30'
      : `cat "$rec/keyscan.stdout"; cat "$rec/keyscan.stderr" >&2; exit 0`;
  if (behaviour !== 'hang') {
    await writeFile(join(recordDir, 'keyscan.stdout'), behaviour.stdout ?? '');
    await writeFile(join(recordDir, 'keyscan.stderr'), behaviour.stderr ?? '');
  }
  const script = `#!/bin/sh
rec='${recordDir}'
printf '%s\\0' "$@" > "$rec/keyscan.args"
env -0 > "$rec/keyscan.env"
${output}
`;
  return writeExecutable(join(dir, 'fake-ssh-keyscan'), script);
}

export async function keyscanInvocation(recordDir: string) {
  const read = (name: string) => readFile(join(recordDir, name), 'utf8');
  return {
    args: (await read('keyscan.args')).split('\0').slice(0, -1),
    env: parseEnv(await read('keyscan.env')),
  };
}

async function writeExecutable(path: string, script: string): Promise<string> {
  await writeFile(path, script);
  await chmod(path, 0o755);
  return path;
}

function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of raw.split('\0').filter(Boolean)) {
    const at = entry.indexOf('=');
    env[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return env;
}

export async function gitInvocations(recordDir: string): Promise<Invocation[]> {
  const count = (await readdir(recordDir)).filter((name) => /^git-\d+\.args$/.test(name)).length;
  const invocations: Invocation[] = [];
  for (let n = 0; n < count; n++) {
    const base = join(recordDir, `git-${n}`);
    const [args, env, cwd, limits] = await Promise.all([
      readFile(`${base}.args`, 'utf8'),
      readFile(`${base}.env`, 'utf8'),
      readFile(`${base}.cwd`, 'utf8'),
      readFile(`${base}.limits`, 'utf8'),
    ]);
    invocations.push({
      args: args.split('\0').slice(0, -1),
      env: parseEnv(env),
      cwd: cwd.trim(),
      limits,
    });
  }
  return invocations;
}

export async function sshInvocation(recordDir: string) {
  const read = (name: string) => readFile(join(recordDir, name), 'utf8');
  return {
    args: (await read('ssh.args')).split('\0').slice(0, -1),
    env: parseEnv(await read('ssh.env')),
    keyMode: (await read('ssh.key-mode')).trim(),
    key: await read('ssh.key'),
    keyPath: (await read('ssh.key-path')).trim(),
    knownHosts: await read('ssh.known-hosts'),
  };
}
